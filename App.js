import React, { useEffect, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio as ExpoAudio } from 'expo-av';
import * as Speech from 'expo-speech';

const CONFIG_KEY = 'salud-deporte:config';
const NOTES_KEY = 'salud-deporte:notas';
const PROGRESION_KEY = 'salud-deporte:progresion';

// Rangos de reps con respaldo en la literatura de sobrecarga progresiva:
// fuerza 1-6 reps, hipertrofia 6-15 reps. Fijos para evitar rangos sin límite.
const REP_RANGE_PRESETS = {
  fuerza: ['1-3', '3-5', '4-6'],
  hipertrofia: ['6-10', '8-12', '10-15'],
};

const COLORS = {
  bg: '#fafafa',
  panel: '#ffffff',
  accent: '#6366f1',
  text: '#1a1a2e',
  muted: '#55556e',
  rest: '#10b981',
  ready: '#f59e0b',
  border: '#e5e5ee',
  ghost: '#6b7280',
  danger: '#ef4444',
};

const SOUND_NAMES = ['clasico', 'agudo', 'grave'];
const SOUND_LABELS = { clasico: 'Clásico', agudo: 'Agudo', grave: 'Grave' };

const BELL_ASSET = require('./assets/campana_boxeo.mp3');
const RACE_ASSET = require('./assets/inicio_carrera_v2.wav');

const SOUND_PRESETS = {
  clasico: {
    rest: require('./assets/rest_clasico.wav'),
    done: require('./assets/done_clasico.wav'),
  },
  agudo: {
    rest: require('./assets/rest_agudo.wav'),
    done: require('./assets/done_agudo.wav'),
  },
  grave: {
    rest: require('./assets/rest_grave.wav'),
    done: require('./assets/done_grave.wav'),
  },
};

const isWeb = Platform.OS === 'web';

function formatTimeInput(digits) {
  if (!digits) return '';
  const d = digits.padStart(3, '0');
  let minutes = parseInt(d.slice(0, -2), 10) || 0;
  let seconds = parseInt(d.slice(-2), 10) || 0;
  if (seconds >= 60) {
    minutes += Math.floor(seconds / 60);
    seconds = seconds % 60;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function secondsToDisplay(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseTime(str) {
  const s = (str || '').trim();
  if (!s) return NaN;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) return NaN;
    const m = Math.floor(Number(parts[0]));
    const sec = Math.floor(Number(parts[1]));
    if (!Number.isFinite(m) || m < 0 || !Number.isFinite(sec) || sec < 0 || sec > 59) return NaN;
    return m * 60 + sec;
  }
  const n = Math.floor(Number(s));
  return Number.isFinite(n) ? n : NaN;
}

function buildPhases(work, rest, series) {
  const phases = [];
  phases.push({ type: 'ready', seconds: 10 });
  for (let i = 0; i < series; i++) {
    phases.push({ type: 'work', seconds: work, seriesNumber: i + 1 });
    if (i < series - 1) {
      phases.push({ type: 'rest', seconds: rest, seriesNumber: i + 1 });
    }
  }
  return phases;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function epley(weight, reps) {
  return round1(weight * (1 + reps / 30));
}

function bestE1RM(session) {
  if (!session || !Array.isArray(session.sets) || session.sets.length === 0) return 0;
  return Math.max(...session.sets.map((s) => epley(s.weight, s.reps)));
}

function firstSetWeight(session) {
  if (!session || !Array.isArray(session.sets) || session.sets.length === 0) return 0;
  return session.sets[0].weight;
}

function sessionHitTop(session, repMax) {
  const max = Number(repMax);
  if (!Number.isFinite(max)) return false;
  const sets = (session?.sets || []).filter((s) => s && Number.isFinite(Number(s.reps)));
  return sets.length > 0 && sets.every((s) => Number(s.reps) >= max);
}

function suggestionFor(ex) {
  const sessions = ex.sessions || [];
  if (sessions.length === 0) {
    return {
      weight: null,
      reps: ex.repMin,
      reason: 'Primera sesión: elige un peso que puedas mover en el rango',
    };
  }
  const last = sessions[sessions.length - 1];
  const validSets = (last?.sets || []).filter(
    (s) => s && Number.isFinite(Number(s.weight)) && Number.isFinite(Number(s.reps)),
  );
  if (validSets.length === 0) {
    return {
      weight: null,
      reps: ex.repMin,
      reason: 'Registra al menos una serie para ver la siguiente sugerencia.',
    };
  }
  const lastWeight = Number(validSets[0].weight);
  const topReps = Math.max(...validSets.map((s) => Number(s.reps)));
  const repMax = Number(ex.repMax);
  const repMin = Number(ex.repMin);
  if (sessionHitTop(last, repMax)) {
    const increment = Number.isFinite(Number(ex.incrementKg)) ? Number(ex.incrementKg) : 0;
    return {
      weight: round1(lastWeight + increment),
      reps: Number.isFinite(repMin) ? repMin : repMax,
      reason: `Todas las series llegaron a ${repMax} reps. Sube la carga.`,
    };
  }
  return {
    weight: round1(lastWeight),
    reps: Math.min(topReps + 1, repMax),
    reason: `Mantén el peso y completa ${repMax} reps en todas las series antes de subir la carga.`,
  };
}

function normalizeExercise(ex) {
  const repMin = Number.isFinite(Number(ex?.repMin)) && Number(ex.repMin) >= 1
    ? Math.floor(Number(ex.repMin))
    : 3;
  const repMax = Number.isFinite(Number(ex?.repMax)) && Number(ex.repMax) >= repMin
    ? Math.floor(Number(ex.repMax))
    : Math.max(repMin, 5);
  const incrementKg = Number.isFinite(Number(ex?.incrementKg)) && Number(ex.incrementKg) > 0
    ? round1(Number(ex.incrementKg))
    : 2.5;
  const sessions = Array.isArray(ex?.sessions)
    ? ex.sessions.map((s) => ({
        ts: Number(s?.ts) || Date.now(),
        sets: Array.isArray(s?.sets)
          ? s.sets
              .filter((st) => st && Number.isFinite(Number(st.weight)) && Number.isFinite(Number(st.reps)))
              .map((st) => ({ weight: round1(Number(st.weight)), reps: Math.floor(Number(st.reps)), rir: Number.isFinite(Number(st.rir)) ? Number(st.rir) : 0 }))
          : [],
      }))
    : [];
  return { ...ex, repMin, repMax, incrementKg, sessions };
}

function parseRepRange(str) {
  const parts = (str || '').trim().split(/-|–|—/).filter((p) => p !== '');
  const nums = parts.map((p) => Math.floor(Number(p)));
  if (nums.length === 1 && Number.isFinite(nums[0]) && nums[0] >= 1) {
    return { min: nums[0], max: nums[0] };
  }
  if (
    nums.length === 2 &&
    Number.isFinite(nums[0]) &&
    Number.isFinite(nums[1]) &&
    nums[0] >= 1 &&
    nums[0] <= nums[1]
  ) {
    return { min: nums[0], max: nums[1] };
  }
  return null;
}

function rirLabel(rir) {
  return rir === 4 ? '4+' : String(rir);
}

function noteUpdatedLabel(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `Actualizada ${dd}/${mm} ${hh}:${mi}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('tabata');

  return (
    <View style={styles.app}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Salud y Deporte</Text>
          <Text style={styles.tagline}>Tabata · Notas · Progresión · Glosario</Text>
        </View>

        <View style={styles.tabBar}>
          <TabButton
            label="Tabata"
            active={activeTab === 'tabata'}
            onPress={() => setActiveTab('tabata')}
          />
          <TabButton
            label="Notas"
            active={activeTab === 'notas'}
            onPress={() => setActiveTab('notas')}
          />
          <TabButton
            label="Progresión"
            active={activeTab === 'progresion'}
            onPress={() => setActiveTab('progresion')}
          />
          <TabButton
            label="Glosario"
            active={activeTab === 'glosario'}
            onPress={() => setActiveTab('glosario')}
          />
        </View>

        <View style={[styles.view, { display: activeTab === 'tabata' ? 'flex' : 'none' }]}>
          <TabataScreen />
        </View>
        <View style={[styles.view, { display: activeTab === 'notas' ? 'flex' : 'none' }]}>
          <NotesScreen />
        </View>
        <View style={[styles.view, { display: activeTab === 'progresion' ? 'flex' : 'none' }]}>
          <ProgresionScreen />
        </View>
        <View style={[styles.view, { display: activeTab === 'glosario' ? 'flex' : 'none' }]}>
          <GlosarioScreen />
        </View>
      </View>
    </View>
  );
}

function TabButton({ label, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function TabataScreen() {
  const [workInput, setWorkInput] = useState('0:30');
  const [restInput, setRestInput] = useState('0:15');
  const [seriesInput, setSeriesInput] = useState('5');
  const [sound, setSound] = useState('clasico');
  const soundRef = useRef('clasico');
  const [configError, setConfigError] = useState('');

  const [screen, setScreen] = useState('config');
  const [phaseType, setPhaseType] = useState('work');
  const [phaseLabel, setPhaseLabel] = useState('Trabajo');
  const [timeDisplay, setTimeDisplay] = useState('30');
  const [seriesCounter, setSeriesCounter] = useState('Serie 1 de 5');
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [summary, setSummary] = useState('');

  const phasesRef = useRef([]);
  const idxRef = useRef(0);
  const remainingMsRef = useRef(0);
  const endTimeRef = useRef(0);
  const intervalRef = useRef(null);
  const mutedRef = useRef(false);
  const sessionRef = useRef({ work: 30, rest: 15, series: 5 });

  const bellRef = useRef(null);
  const raceRef = useRef(null);
  const bellPromiseRef = useRef(null);
  const racePromiseRef = useRef(null);
  const webBellRef = useRef(null);
  const webRaceRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CONFIG_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (Number.isFinite(saved.work) && saved.work >= 1) {
          setWorkInput(secondsToDisplay(Math.floor(saved.work)));
        }
        if (Number.isFinite(saved.rest) && saved.rest >= 1) {
          setRestInput(secondsToDisplay(Math.floor(saved.rest)));
        }
        if (Number.isFinite(saved.series) && saved.series >= 1) {
          setSeriesInput(String(saved.series));
        }
        if (saved.sound && SOUND_NAMES.includes(saved.sound)) {
          setSound(saved.sound);
          soundRef.current = saved.sound;
        }
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
      const unload = (ref) => {
        if (ref.current) {
          try { ref.current.unloadAsync(); } catch (_) {}
          ref.current = null;
        }
      };
      unload(bellRef);
      unload(raceRef);
      Object.values(toneSoundRef.current).forEach((promise) => {
        if (promise && typeof promise.then === 'function') {
          promise.then((s) => { try { s.unloadAsync(); } catch (_) {} }).catch(() => {});
        }
      });
      toneSoundRef.current = {};
      toneWebRef.current = {};
      bellPromiseRef.current = null;
      racePromiseRef.current = null;
      webBellRef.current = null;
      webRaceRef.current = null;
    };
  }, []);

  function say(text) {
    if (mutedRef.current) return;
    try {
      Speech.speak(text, { language: 'es-419', pitch: 1.2, rate: 1.12 });
    } catch (_) {}
  }

  function playWebAudio(el) {
    if (!el) return;
    try {
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }

  function getWebBell() {
    if (!webBellRef.current && typeof window !== 'undefined') {
      webBellRef.current = new window.Audio(BELL_ASSET);
    }
    return webBellRef.current;
  }

  function getWebRace() {
    if (!webRaceRef.current && typeof window !== 'undefined') {
      webRaceRef.current = new window.Audio(RACE_ASSET);
    }
    return webRaceRef.current;
  }

  function loadBell() {
    if (!bellPromiseRef.current) {
      bellPromiseRef.current = ExpoAudio.Sound.createAsync(BELL_ASSET).then((res) => {
        bellRef.current = res.sound;
        return res.sound;
      });
    }
    return bellPromiseRef.current;
  }

  function loadRace() {
    if (!racePromiseRef.current) {
      racePromiseRef.current = ExpoAudio.Sound.createAsync(RACE_ASSET).then((res) => {
        raceRef.current = res.sound;
        return res.sound;
      });
    }
    return racePromiseRef.current;
  }

  async function playBell() {
    if (mutedRef.current) return;
    if (isWeb) {
      playWebAudio(getWebBell());
      return;
    }
    try {
      const s = await loadBell();
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch (_) {}
  }

  async function playRace() {
    if (mutedRef.current) return;
    if (isWeb) {
      playWebAudio(getWebRace());
      return;
    }
    try {
      const s = await loadRace();
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch (_) {}
  }

  const toneSoundRef = useRef({});
  const toneWebRef = useRef({});

  function getWebTone(asset) {
    if (!toneWebRef.current[asset] && typeof window !== 'undefined') {
      toneWebRef.current[asset] = new window.Audio(asset);
    }
    return toneWebRef.current[asset];
  }

  async function playToneAsset(asset) {
    if (mutedRef.current) return;
    if (isWeb) {
      playWebAudio(getWebTone(asset));
      return;
    }
    try {
      if (!toneSoundRef.current[asset]) {
        toneSoundRef.current[asset] = ExpoAudio.Sound.createAsync(asset).then((res) => res.sound);
      }
      const s = await toneSoundRef.current[asset];
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch (_) {}
  }

  function playRestTone() {
    const preset = SOUND_PRESETS[soundRef.current] || SOUND_PRESETS.clasico;
    playToneAsset(preset.rest);
  }

  function playDone() {
    const preset = SOUND_PRESETS[soundRef.current] || SOUND_PRESETS.clasico;
    playToneAsset(preset.done);
  }

  function beginPhase() {
    if (idxRef.current >= phasesRef.current.length) {
      finish();
      return;
    }
    const phase = phasesRef.current[idxRef.current];
    phase.halfSaid = false;
    phase.tenSaid = false;
    phase.carreraPlayed = false;
    const totalSeries = sessionRef.current.series;

    if (phase.type === 'ready') {
      setPhaseType('ready');
      setPhaseLabel('Prepárate');
      setSeriesCounter(`Serie 1 de ${totalSeries}`);
      say('Atención');
    } else if (phase.type === 'work') {
      setPhaseType('work');
      setPhaseLabel('Trabajo');
      setSeriesCounter(`Serie ${phase.seriesNumber} de ${totalSeries}`);
      playBell();
    } else {
      setPhaseType('rest');
      setPhaseLabel('Descanso');
      setSeriesCounter(`Descanso ${phase.seriesNumber} de ${totalSeries - 1}`);
      say('Descanso');
      playRestTone();
    }

    remainingMsRef.current = phase.seconds * 1000;
    endTimeRef.current = Date.now() + remainingMsRef.current;
    setTimeDisplay(String(Math.ceil(remainingMsRef.current / 1000)));
    setProgress(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(tick, 100);
  }

  function tick() {
    remainingMsRef.current = Math.max(0, endTimeRef.current - Date.now());
    const phase = phasesRef.current[idxRef.current];
    const shownSecond = Math.ceil(remainingMsRef.current / 1000);
    setTimeDisplay(String(shownSecond));
    const total = phase.seconds * 1000;
    setProgress(Math.min(100, ((total - remainingMsRef.current) / total) * 100));

    if (!phase.carreraPlayed && remainingMsRef.current <= 3000) {
      phase.carreraPlayed = true;
      playRace();
    }

    if (phase.type === 'work') {
      const totalMs = phase.seconds * 1000;
      if (!phase.halfSaid && remainingMsRef.current <= totalMs / 2) {
        phase.halfSaid = true;
        say('Llevas la mitad');
      }
      if (!phase.tenSaid && remainingMsRef.current <= 10000 && totalMs > 10000) {
        phase.tenSaid = true;
        say('10 segundos');
      }
    }

    if (remainingMsRef.current <= 0) {
      idxRef.current++;
      beginPhase();
    }
  }

  const doneTimeoutRef = useRef(null);

  function finish() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    const totalSec = phasesRef.current.reduce(
      (acc, p) => acc + (p.type === 'ready' ? 0 : p.seconds),
      0
    );
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    const { series, work, rest } = sessionRef.current;
    setSummary(`${series} series · ${work}s trabajo / ${rest}s descanso · total ${mm}m ${ss}s`);
    setScreen('done');
    if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
    doneTimeoutRef.current = setTimeout(playDone, 1300);
  }

  function start() {
    const work = parseTime(workInput);
    const rest = parseTime(restInput);
    const series = Math.floor(Number(seriesInput));
    if (
      !Number.isFinite(work) || work < 1 ||
      !Number.isFinite(rest) || rest < 1 ||
      !Number.isFinite(series) || series < 1
    ) {
      setConfigError('Ingresa tiempos válidos en formato MM:SS (ej: 1:30) y al menos 1 serie.');
      return;
    }
    setConfigError('');
    sessionRef.current = { work, rest, series };
    phasesRef.current = buildPhases(work, rest, series);
    idxRef.current = 0;
    saveConfig({ work, rest, series, sound });
    setIsPaused(false);
    setScreen('timer');
    beginPhase();
  }

  async function saveConfig(cfg) {
    try {
      await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    } catch (_) {}
  }

  function chooseSound(name) {
    setSound(name);
    soundRef.current = name;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CONFIG_KEY);
        const saved = raw ? JSON.parse(raw) : {};
        saved.sound = name;
        await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(saved));
      } catch (_) {}
    })();
  }

  function togglePause() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      remainingMsRef.current = Math.max(0, endTimeRef.current - Date.now());
      setIsPaused(true);
    } else {
      endTimeRef.current = Date.now() + remainingMsRef.current;
      intervalRef.current = setInterval(tick, 100);
      setIsPaused(false);
    }
  }

  function reset() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (doneTimeoutRef.current) {
      clearTimeout(doneTimeoutRef.current);
      doneTimeoutRef.current = null;
    }
    setIsPaused(false);
    setScreen('config');
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
  }

  const phaseColor =
    phaseType === 'ready' ? COLORS.ready : phaseType === 'rest' ? COLORS.rest : COLORS.accent;

  if (screen === 'timer') {
    return (
      <View style={styles.timerWrap}>
        <View style={[styles.panel, styles.timerPanel]}>
          <Text style={[styles.phaseLabel, { color: phaseColor }]}>{phaseLabel}</Text>
          <Text style={styles.timeDisplay}>{timeDisplay}</Text>
          <Text style={styles.seriesCounter}>{seriesCounter}</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
          <View style={styles.controls}>
            <TouchableOpacity style={styles.btn} onPress={togglePause}>
              <Text style={styles.btnText}>{isPaused ? 'Reanudar' : 'Pausar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={reset}>
              <Text style={styles.btnGhostText}>Salir</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost, styles.muteBtn]}
              onPress={toggleMute}
              accessibilityLabel="Silenciar"
            >
              <Text style={styles.muteIcon}>{muted ? '🔇' : '🔊'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  if (screen === 'done') {
    return (
      <View style={styles.timerWrap}>
        <View style={[styles.panel, styles.timerPanel]}>
          <Text style={styles.doneIcon}>🏁</Text>
          <Text style={styles.panelTitle}>¡Sesión completa!</Text>
          <Text style={styles.doneSummary}>{summary}</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={reset}>
            <Text style={styles.btnPrimaryText}>Nueva sesión</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Configurar sesión</Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Trabajo (MM:SS)</Text>
          <TextInput
            style={styles.input}
            value={workInput}
            onChangeText={(t) => setWorkInput(formatTimeInput(t.replace(/\D/g, '')))}
            keyboardType="number-pad"
            placeholder="0:30"
            placeholderTextColor="#9ca3af"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Descanso (MM:SS)</Text>
          <TextInput
            style={styles.input}
            value={restInput}
            onChangeText={(t) => setRestInput(formatTimeInput(t.replace(/\D/g, '')))}
            keyboardType="number-pad"
            placeholder="0:15"
            placeholderTextColor="#9ca3af"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Series</Text>
          <TextInput
            style={styles.input}
            value={seriesInput}
            onChangeText={(t) => setSeriesInput(t.replace(/\D/g, ''))}
            keyboardType="number-pad"
            placeholder="5"
            placeholderTextColor="#9ca3af"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Sonido</Text>
          <View style={styles.soundRow}>
            {SOUND_NAMES.map((name) => (
              <TouchableOpacity
                key={name}
                style={[styles.soundChip, sound === name && styles.soundChipActive]}
                onPress={() => chooseSound(name)}
              >
                <Text style={[styles.soundChipText, sound === name && styles.soundChipTextActive]}>
                  {SOUND_LABELS[name]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TouchableOpacity style={styles.btnPrimary} onPress={start}>
          <Text style={styles.btnPrimaryText}>Comenzar</Text>
        </TouchableOpacity>

        {configError ? <Text style={styles.error}>{configError}</Text> : null}
      </View>
    </ScrollView>
  );
}

function NotesScreen() {
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(NOTES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        setNotes(Array.isArray(parsed) ? parsed : []);
      } catch (_) {}
    })();
  }, []);

  function persist(next) {
    try {
      AsyncStorage.setItem(NOTES_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function handleNewNote() {
    setNotes((prev) => {
      const next = [{ id: makeId(), title: '', body: '', updatedAt: Date.now() }, ...prev];
      persist(next);
      return next;
    });
  }

  function handleSave(id, title, body) {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, title, body, updatedAt: Date.now() } : n));
      persist(next);
      return next;
    });
  }

  function handleDelete(id) {
    setNotes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      persist(next);
      return next;
    });
  }

  const sorted = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
        <View style={styles.notesHeader}>
          <Text style={styles.panelTitle}>Notas</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={handleNewNote}>
            <Text style={styles.btnPrimaryText}>+ Nueva nota</Text>
          </TouchableOpacity>
        </View>

        {sorted.length === 0 ? (
          <Text style={styles.notesEmpty}>
            No hay notas todavía. Crea la primera con «+ Nueva nota».
          </Text>
        ) : (
          sorted.map((note) => (
            <NoteCard key={note.id} note={note} onSave={handleSave} onDelete={handleDelete} />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function NoteCard({ note, onSave, onDelete }) {
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');

  return (
    <View style={styles.noteCard}>
      <TextInput
        style={styles.noteTitle}
        placeholder="Título (ej: alumno)"
        placeholderTextColor="#9ca3af"
        value={title}
        onChangeText={setTitle}
      />
      <TextInput
        style={styles.noteBody}
        placeholder="Escribe tus comentarios..."
        placeholderTextColor="#9ca3af"
        value={body}
        onChangeText={setBody}
        multiline
      />
      <Text style={styles.noteMeta}>{noteUpdatedLabel(note.updatedAt || Date.now())}</Text>
      <View style={styles.noteActions}>
        <TouchableOpacity style={styles.btnPrimary} onPress={() => onSave(note.id, title, body)}>
          <Text style={styles.btnPrimaryText}>Guardar</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => onDelete(note.id)}>
          <Text style={styles.btnGhostText}>Eliminar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const RIR_OPTIONS = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '+3', value: 4 },
];

const GLOSARIO_TERMS = [
  {
    title: 'Sobrecarga progresiva',
    text: 'Aumentar de forma gradual y sistemática la demanda sobre el músculo (carga, reps, series o frecuencia) para seguir progresando.',
  },
  {
    title: 'Fuerza',
    text: 'Capacidad de mover una carga pesada. Se entrena mejor con cargas altas (≥80% de tu máximo) y pocas reps (1–6).',
  },
  {
    title: 'Hipertrofia',
    text: 'Crecimiento del músculo. Se logra con un rango amplio de reps (5–30) llevando las series cerca del fallo (RIR 1–3).',
  },
  {
    title: 'Repetición (rep)',
    text: 'Una ejecución completa del ejercicio.',
  },
  {
    title: 'Serie (set)',
    text: 'Grupo de repeticiones seguidas con un descanso después.',
  },
  {
    title: 'Volumen',
    text: 'Cantidad total de trabajo, normalmente series × repeticiones por músculo o por sesión.',
  },
  {
    title: 'Intensidad / %1RM',
    text: 'Qué tan pesada es la carga respecto a tu repetición máxima; se expresa en porcentaje del 1RM.',
  },
  {
    title: '1RM',
    text: 'Una repetición máxima: el máximo peso que puedes levantar una sola vez con buena técnica.',
  },
  {
    title: 'e1RM',
    text: '1RM estimado a partir de reps sub-máximas (fórmula de Epley). Sirve para seguir el progreso sin testear tu máximo.',
  },
  {
    title: 'RIR (reps en reserva)',
    text: 'Cuántas repeticiones te quedaban al terminar una serie. RIR 2 significa que podías hacer 2 más.',
  },
  {
    title: 'RPE',
    text: 'Escala de esfuerzo percibido (1–10). RPE 9 ≈ RIR 1; RPE 10 = fallo.',
  },
  {
    title: 'Fallo muscular',
    text: 'No poder completar otra repetición con buena técnica. Útil de forma ocasional, no en todas las series.',
  },
  {
    title: 'Rango de repeticiones',
    text: 'El mínimo y máximo de reps que usas en una serie para un objetivo.',
  },
  {
    title: 'Doble progresión',
    text: 'Primero subir reps dentro del rango y, al llegar al tope, subir la carga y volver al piso del rango.',
  },
  {
    title: 'Progresión lineal',
    text: 'Subir la carga de forma fija cada sesión o semana (ideal para principiantes).',
  },
  {
    title: 'Frecuencia',
    text: 'Cuántas veces a la semana entrenas un músculo o ejercicio.',
  },
  {
    title: 'Descanso entre series',
    text: 'Pausa para recuperar. Fuerza: 2–5 min. Hipertrofia: 1–3 min.',
  },
  {
    title: 'Deload (descarga)',
    text: 'Semana de menos carga o volumen para recuperar fatiga acumulada.',
  },
  {
    title: 'PR (personal record)',
    text: 'Tu mejor marca personal en un ejercicio (peso, reps o volumen).',
  },
  {
    title: 'Estancamiento / meseta',
    text: 'Sin mejora durante varias sesiones pese a entrenar bien. Señal para ajustar algo.',
  },
];

function ProgresionScreen() {
  const [exercises, setExercises] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formGoal, setFormGoal] = useState('fuerza');
  const [formRepRange, setFormRepRange] = useState('3-5');
  const [formIncrement, setFormIncrement] = useState('2.5');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PROGRESION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed?.exercises)
          ? parsed.exercises.map((ex) => normalizeExercise(ex))
          : [];
        setExercises(arr);
        const seeded = {};
        arr.forEach((ex) => { seeded[ex.id] = seedDraft(ex); });
        setDrafts(seeded);
      } catch (_) {}
    })();
  }, []);

  function persistExercises(next) {
    try {
      AsyncStorage.setItem(PROGRESION_KEY, JSON.stringify({ exercises: next }));
    } catch (_) {}
  }

  function updateDraft(id, patch) {
    setDrafts((prev) => {
      const cur = prev[id] || { weight: '', reps: '', rir: 2, sets: [] };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  function draftOf(id) {
    return drafts[id] || { weight: '', reps: '', rir: 2, sets: [] };
  }

  function seedDraft(ex) {
    const sug = suggestionFor(ex);
    return {
      weight: sug.weight !== null ? String(sug.weight) : '',
      reps: String(sug.reps),
      rir: 2,
      sets: [],
    };
  }

  function resetForm() {
    setFormName('');
    setFormGoal('fuerza');
    setFormRepRange('3-5');
    setFormIncrement('2.5');
    setFormError('');
    setShowForm(false);
  }

  function chooseGoal(goal) {
    setFormGoal(goal);
    setFormRepRange(goal === 'fuerza' ? '3-5' : '8-12');
  }

  function saveExercise() {
    const name = formName.trim();
    const range = parseRepRange(formRepRange);
    const inc = Number(formIncrement);
    if (!name) {
      setFormError('Ingresa un nombre para el ejercicio.');
      return;
    }
    if (!range) {
      setFormError('El rango de reps debe ser como "8-12" (mínimo-máximo).');
      return;
    }
    const incrementKg = Number.isFinite(inc) && inc > 0 ? round1(inc) : 2.5;
    const ex = {
      id: makeId(),
      name,
      goal: formGoal,
      repMin: range.min,
      repMax: range.max,
      incrementKg,
      sessions: [],
    };
    setExercises((prev) => {
      const next = [...prev, ex];
      persistExercises(next);
      return next;
    });
    setDrafts((prev) => ({ ...prev, [ex.id]: seedDraft(ex) }));
    resetForm();
  }

  function deleteExercise(id) {
    setExercises((prev) => {
      const next = prev.filter((e) => e.id !== id);
      persistExercises(next);
      return next;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function addSet(ex) {
    const d = draftOf(ex.id);
    const weight = parseFloat(d.weight);
    const reps = parseInt(d.reps, 10);
    const rir = d.rir;
    if (!Number.isFinite(weight) || weight <= 0) {
      updateDraft(ex.id, { error: 'Ingresa un peso válido (kg).' });
      return;
    }
    if (!Number.isFinite(reps) || reps < 1) {
      updateDraft(ex.id, { error: 'Ingresa una cantidad de reps válida.' });
      return;
    }
    const set = { weight: round1(weight), reps, rir };
    setDrafts((prev) => {
      const cur = prev[ex.id] || { weight: '', reps: '', rir: 2, sets: [] };
      return {
        ...prev,
        [ex.id]: { ...cur, weight: String(set.weight), reps: '', rir, sets: [...cur.sets, set], error: '' },
      };
    });
  }

  function removeSet(exId, index) {
    setDrafts((prev) => {
      const cur = prev[exId] || { weight: '', reps: '', rir: 2, sets: [] };
      return { ...prev, [exId]: { ...cur, sets: cur.sets.filter((_, i) => i !== index) } };
    });
  }

  function finishSession(ex) {
    const d = draftOf(ex.id);
    if (!d.sets || d.sets.length === 0) return;
    const session = { ts: Date.now(), sets: d.sets };
    const updatedEx = { ...ex, sessions: [...ex.sessions, session] };
    setExercises((prev) => {
      const next = prev.map((e) => (e.id === ex.id ? updatedEx : e));
      persistExercises(next);
      return next;
    });
    setDrafts((prev) => ({ ...prev, [ex.id]: seedDraft(updatedEx) }));
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
        <View style={styles.notesHeader}>
          <Text style={styles.panelTitle}>Progresión</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={() => setShowForm((v) => !v)}>
            <Text style={styles.btnPrimaryText}>{showForm ? 'Cerrar' : '+ Nuevo ejercicio'}</Text>
          </TouchableOpacity>
        </View>

        {showForm ? (
          <View style={styles.formPanel}>
            <Text style={styles.sectionTitle}>Nuevo ejercicio</Text>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Nombre</Text>
              <TextInput
                style={styles.input}
                value={formName}
                onChangeText={setFormName}
                placeholder="Ej: Press banca"
                placeholderTextColor="#9ca3af"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Objetivo</Text>
              <View style={styles.chipRow}>
                {['fuerza', 'hipertrofia'].map((goal) => (
                  <TouchableOpacity
                    key={goal}
                    style={[styles.goalChip, formGoal === goal && styles.goalChipActive]}
                    onPress={() => chooseGoal(goal)}
                  >
                    <Text
                      style={[
                        styles.goalChipText,
                        formGoal === goal && styles.goalChipTextActive,
                      ]}
                    >
                      {goal === 'fuerza' ? 'Fuerza' : 'Hipertrofia'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Rango de reps</Text>
              <View style={styles.chipRow}>
                {(REP_RANGE_PRESETS[formGoal] || []).map((range) => (
                  <TouchableOpacity
                    key={range}
                    style={[styles.goalChip, formRepRange === range && styles.goalChipActive]}
                    onPress={() => setFormRepRange(range)}
                  >
                    <Text
                      style={[
                        styles.goalChipText,
                        formRepRange === range && styles.goalChipTextActive,
                      ]}
                    >
                      {range}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.fieldHint}>
                {formGoal === 'fuerza'
                  ? 'Fuerza: 1-6 reps por serie.'
                  : 'Hipertrofia: 6-15 reps por serie.'} Opciones fijas con límite sano.
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Subida de carga (kg)</Text>
              <TextInput
                style={styles.input}
                value={formIncrement}
                onChangeText={(t) => setFormIncrement(t.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
                placeholder="2.5"
                placeholderTextColor="#9ca3af"
              />
              <Text style={styles.fieldHint}>Kg que sumas al completar el tope del rango de reps.</Text>
            </View>

            {formError ? <Text style={styles.error}>{formError}</Text> : null}

            <TouchableOpacity style={styles.btnPrimary} onPress={saveExercise}>
              <Text style={styles.btnPrimaryText}>Guardar</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {exercises.length === 0 ? (
          <Text style={styles.notesEmpty}>
            No hay ejercicios todavía. Crea el primero con «+ Nuevo ejercicio».
          </Text>
        ) : (
          exercises.map((ex) => (
            <ExerciseCard
              key={ex.id}
              exercise={ex}
              draft={draftOf(ex.id)}
              onField={(patch) => updateDraft(ex.id, patch)}
              onAddSet={() => addSet(ex)}
              onRemoveSet={(index) => removeSet(ex.id, index)}
              onFinish={() => finishSession(ex)}
              onDelete={() => deleteExercise(ex.id)}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function ExerciseCard({ exercise, draft, onField, onAddSet, onRemoveSet, onFinish, onDelete }) {
  const sug = suggestionFor(exercise);
  const weightVal = draft.weight;
  const repsVal = draft.reps;
  const rir = draft.rir;
  const sets = draft.sets || [];

  const sessions = exercise.sessions || [];
  const hasChart = sessions.length >= 2;
  const recent = hasChart ? sessions.slice(-6).map((s) => bestE1RM(s)) : [];
  const chartMax = recent.length > 0 ? Math.max(...recent) : 0;

  let lastSummary = null;
  let isPR = false;
  let isStall = false;
  let historyNote = '';
  if (sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    const best = bestE1RM(last);
    const setCount = last.sets.length;
    const firstReps = last.sets[0]?.reps ?? 0;
    const firstWeight = firstSetWeight(last);
    lastSummary = `${setCount}×${firstReps} @ ${firstWeight} kg · e1RM ${best} kg`;
    if (sessions.length >= 2) {
      const prevBest = Math.max(...sessions.slice(0, -1).map((s) => bestE1RM(s)));
      isPR = best > prevBest;
    }
    if (sessions.length >= 4) {
      const prev = sessions[sessions.length - 4];
      isStall = best <= bestE1RM(prev) && firstWeight <= firstSetWeight(prev);
    }

    const hitTop = sessionHitTop(last, exercise.repMax);
    if (sessions.length === 1) {
      historyNote = 'Primera sesión: ya tienes tu punto de partida.';
    } else {
      const prev = sessions[sessions.length - 2];
      const prevBest = bestE1RM(prev);
      const prevWeight = firstSetWeight(prev);
      if (hitTop && firstWeight > prevWeight) {
        historyNote = `¡Llegaste al tope del rango y subiste la carga a ${firstWeight} kg!`;
      } else if (best > prevBest) {
        historyNote = `Nuevo mejor e1RM: de ${prevBest} a ${best} kg.`;
      } else if (hitTop) {
        historyNote = 'Completaste el tope del rango: la próxima subes la carga.';
      } else {
        historyNote = 'Sumaste reps sin perder ritmo: vas bien.';
      }
    }
    if (sug.weight !== null) {
      historyNote += ` Próximo objetivo: ${sug.weight} kg × ${sug.reps} reps.`;
    }
  }

  return (
    <View style={styles.noteCard}>
      <View style={styles.exerciseHeader}>
        <View style={styles.exerciseTitleWrap}>
          <Text style={styles.exerciseName}>{exercise.name}</Text>
          <View style={styles.goalBadge}>
            <Text style={styles.goalBadgeText}>
              {exercise.goal === 'fuerza' ? 'Fuerza' : 'Hipertrofia'}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.btnSmallGhost} onPress={onDelete}>
          <Text style={styles.btnSmallGhostText}>Eliminar</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sugBox}>
        <Text style={styles.sugLine}>
          {sug.weight !== null
            ? `${sug.weight} kg × ${sug.reps} reps`
            : `Primera sesión: elige un peso y haz ${exercise.repMin} reps`}
        </Text>
        <Text style={styles.sugReason}>{sug.reason}</Text>
      </View>

      <Text style={styles.sectionTitle}>Registrar serie</Text>
      <View style={styles.inputRow}>
        <View style={styles.inputCol}>
          <Text style={styles.inputUnitLabel}>Peso (kg)</Text>
          <TextInput
            style={styles.input}
            value={weightVal}
            onChangeText={(t) => onField({ weight: t.replace(/[^0-9.]/g, '') })}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor="#9ca3af"
          />
        </View>
        <View style={styles.inputCol}>
          <Text style={styles.inputUnitLabel}>Reps</Text>
          <TextInput
            style={styles.input}
            value={repsVal}
            onChangeText={(t) => onField({ reps: t.replace(/\D/g, '') })}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor="#9ca3af"
          />
        </View>
      </View>

      <Text style={styles.fieldLabel}>RIR (reps en reserva)</Text>
      <Text style={styles.fieldHint}>¿Cuántas reps más podías hacer al terminar la serie?</Text>
      <View style={styles.rirRow}>
        {RIR_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.label}
            style={[styles.rirChip, rir === opt.value && styles.rirChipActive]}
            onPress={() => onField({ rir: opt.value })}
          >
            <Text style={[styles.rirChipText, rir === opt.value && styles.rirChipTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {draft.error ? <Text style={styles.error}>{draft.error}</Text> : null}

      <TouchableOpacity style={styles.btnPrimary} onPress={onAddSet}>
        <Text style={styles.btnPrimaryText}>Agregar serie</Text>
      </TouchableOpacity>

      {sets.length > 0 ? (
        <View style={styles.seriesList}>
          {sets.map((s, i) => (
            <View key={i} style={styles.seriesRow}>
              <Text style={styles.seriesText}>
                Serie {i + 1}: {s.weight} kg × {s.reps} (RIR {rirLabel(s.rir)})
              </Text>
              <TouchableOpacity style={styles.btnSmallGhost} onPress={() => onRemoveSet(i)}>
                <Text style={styles.btnSmallGhostText}>Quitar</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={[styles.btnPrimary, styles.finishBtn]} onPress={onFinish}>
            <Text style={styles.btnPrimaryText}>Terminar sesión</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {lastSummary ? (
        <View style={styles.historyBox}>
          <Text style={styles.historyTitle}>Historial</Text>
          {historyNote ? <Text style={styles.historyNote}>{historyNote}</Text> : null}
          <Text style={styles.historyLine}>Última: {lastSummary}</Text>
          {isPR ? <Text style={styles.prText}>🏆 Nuevo PR de e1RM</Text> : null}
          {isStall ? (
            <Text style={styles.stallText}>
              Posible estancamiento: prueba una semana de descarga (deload) o ajusta una variable.
            </Text>
          ) : null}
          {hasChart ? (
            <View style={styles.chart}>
              {recent.map((v, i) => {
                const h = chartMax > 0 ? Math.max(6, Math.round((v / chartMax) * 64)) : 6;
                return (
                  <View key={i} style={styles.chartCol}>
                    <View style={[styles.chartBar, { height: h }]} />
                    <Text style={styles.chartLabel}>{v}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function GlosarioScreen() {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Glosario</Text>
        {GLOSARIO_TERMS.map((term) => (
          <View key={term.title} style={styles.glossaryCard}>
            <Text style={styles.glossaryTitle}>{term.title}</Text>
            <Text style={styles.glossaryText}>{term.text}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'web' ? 24 : 60,
    paddingBottom: 16,
  },
  header: {
    marginBottom: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.text,
  },
  tagline: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.panel,
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: COLORS.accent,
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.muted,
  },
  tabTextActive: {
    color: '#ffffff',
  },
  view: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  panel: {
    backgroundColor: COLORS.panel,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 16,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.muted,
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: COLORS.text,
  },
  fieldHint: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 4,
    lineHeight: 16,
  },
  inputCol: {
    flex: 1,
    minWidth: 0,
  },
  inputUnitLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.muted,
    marginBottom: 4,
  },
  soundRow: {
    flexDirection: 'row',
    gap: 8,
  },
  soundChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  soundChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  soundChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.muted,
  },
  soundChipTextActive: {
    color: '#ffffff',
  },
  btnPrimary: {
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnPrimaryText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  btn: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: {
    color: COLORS.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderColor: COLORS.border,
  },
  btnGhostText: {
    color: COLORS.ghost,
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: COLORS.danger,
    fontSize: 13,
    marginTop: 12,
  },
  timerWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  timerPanel: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  phaseLabel: {
    fontSize: 20,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  timeDisplay: {
    fontSize: 88,
    fontWeight: '800',
    color: COLORS.text,
    marginTop: 8,
  },
  seriesCounter: {
    fontSize: 15,
    color: COLORS.muted,
    marginTop: 4,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.bg,
    overflow: 'hidden',
    marginTop: 24,
    marginBottom: 24,
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.accent,
    borderRadius: 5,
  },
  controls: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  muteBtn: {
    paddingHorizontal: 14,
  },
  muteIcon: {
    fontSize: 20,
  },
  doneIcon: {
    fontSize: 48,
  },
  doneSummary: {
    fontSize: 15,
    color: COLORS.muted,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 24,
  },
  notesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  notesEmpty: {
    fontSize: 14,
    color: COLORS.muted,
    lineHeight: 20,
  },
  noteCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    backgroundColor: COLORS.bg,
  },
  noteTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    paddingVertical: 4,
  },
  noteBody: {
    fontSize: 14,
    color: COLORS.text,
    minHeight: 64,
    textAlignVertical: 'top',
    paddingVertical: 4,
  },
  noteMeta: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 8,
  },
  noteActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  formPanel: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    backgroundColor: COLORS.bg,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  goalChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  goalChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  goalChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.muted,
  },
  goalChipTextActive: {
    color: '#ffffff',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  inputFlex: {
    flex: 1,
  },
  exerciseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  exerciseTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    flexWrap: 'wrap',
  },
  exerciseName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  goalBadge: {
    backgroundColor: '#eef2ff',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#c7d2fe',
  },
  goalBadgeText: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  btnSmallGhost: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'transparent',
  },
  btnSmallGhostText: {
    color: COLORS.ghost,
    fontSize: 12,
    fontWeight: '600',
  },
  sugBox: {
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sugLine: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  sugReason: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 2,
    lineHeight: 18,
  },
  rirRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  rirChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  rirChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  rirChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.muted,
  },
  rirChipTextActive: {
    color: '#ffffff',
  },
  seriesList: {
    marginTop: 12,
    gap: 8,
  },
  seriesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  seriesText: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },
  finishBtn: {
    marginTop: 12,
  },
  historyBox: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 12,
  },
  historyTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  historyLine: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '600',
  },
  historyNote: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 19,
    marginBottom: 6,
  },
  prText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.ready,
    marginTop: 6,
  },
  stallText: {
    fontSize: 13,
    color: COLORS.danger,
    marginTop: 6,
    lineHeight: 18,
  },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginTop: 12,
    height: 88,
  },
  chartCol: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  chartBar: {
    width: '60%',
    maxWidth: 30,
    minHeight: 6,
    backgroundColor: COLORS.accent,
    borderRadius: 4,
  },
  chartLabel: {
    fontSize: 10,
    color: COLORS.muted,
    marginTop: 4,
  },
  glossaryCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    backgroundColor: COLORS.bg,
  },
  glossaryTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  glossaryText: {
    fontSize: 13,
    color: COLORS.muted,
    lineHeight: 19,
  },
});
