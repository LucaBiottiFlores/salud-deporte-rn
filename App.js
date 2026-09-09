import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
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
import { supabase } from './src/supabase';

const CONFIG_KEY = 'salud-deporte:config';
const NOTES_KEY = 'salud-deporte:notas';
const PROGRESION_KEY = 'salud-deporte:progresion';

const GENERIC_AUTH_ERROR = 'No se pudo completar la acción. Revisá los datos e intentalo de nuevo.';

// Rangos de reps con respaldo en la literatura de sobrecarga progresiva:
// fuerza 1-6 reps, hipertrofia 6-15 reps. Fijos para evitar rangos sin límite.
const REP_RANGE_PRESETS = {
  fuerza: ['1-3', '3-5', '4-6'],
  hipertrofia: ['6-10', '8-12', '10-15'],
};

const LIGHT_COLORS = {
  bg: '#f7f4ef',
  panel: '#ffffff',
  accent: '#2f7a53',
  onAccent: '#ffffff',
  volt: '#2f7a53',
  text: '#222220',
  muted: '#6e6c66',
  rest: '#3e8e6a',
  ready: '#cf8b2f',
  border: '#e7e3db',
  ghost: '#8a877f',
  danger: '#c14f4a',
  softBg: '#eef1ec',
  softBorder: '#d6e0d7',
  prBg: '#f1ece1',
};

const DARK_COLORS = {
  bg: '#101014',
  panel: '#1b1b21',
  accent: '#6ee7a8',
  onAccent: '#0d0d10',
  volt: '#6ee7a8',
  text: '#f2f2f5',
  muted: '#b0b0ba',
  rest: '#4fd1a0',
  ready: '#f0b45a',
  border: '#2a2a33',
  ghost: '#9ca3af',
  danger: '#f27d78',
  softBg: '#1d1d25',
  softBorder: '#2f2f3a',
  prBg: '#1e1e27',
};

const TIMER_COLORS = {
  bg: '#0b0b0f',
  panel: '#15151c',
  accent: '#c8f31d',
  onAccent: '#0b0b0f',
  volt: '#c8f31d',
  text: '#f5f5f7',
  muted: '#9a9aa6',
  rest: '#38bdf8',
  ready: '#f59e0b',
  border: '#26262e',
  ghost: '#9ca3af',
  danger: '#f87171',
  softBg: '#1c1c22',
  softBorder: '#2c2c36',
  prBg: '#1a1a20',
};

const THEMES = { light: LIGHT_COLORS, dark: DARK_COLORS };
const THEME_KEY = 'salud-deporte:theme';
const CALIBRATION_KEY = 'salud-deporte:no-calibracion';

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

function sessionWorkingWeight(session, repMin) {
  if (!session || !Array.isArray(session.sets) || session.sets.length === 0) return 0;
  const min = Number.isFinite(Number(repMin)) ? Number(repMin) : 1;
  const inRange = session.sets.filter(
    (s) => s && Number.isFinite(Number(s.weight)) && Number.isFinite(Number(s.reps)) && Number(s.reps) >= min,
  );
  const pool = inRange.length > 0
    ? inRange
    : session.sets.filter((s) => s && Number.isFinite(Number(s.weight)));
  if (pool.length === 0) return 0;
  const counts = {};
  pool.forEach((s) => {
    const w = Number(s.weight);
    counts[w] = (counts[w] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(counts));
  const modeWeights = Object.keys(counts)
    .filter((w) => counts[w] === maxCount)
    .map(Number);
  return Math.max(...modeWeights);
}

function sessionHitTop(session, repMax) {
  const max = Number(repMax);
  if (!Number.isFinite(max)) return false;
  const sets = (session?.sets || []).filter((s) => s && Number.isFinite(Number(s.reps)));
  return sets.length > 0 && sets.every((s) => Number(s.reps) >= max);
}

function sessionVolume(session) {
  const sets = (session?.sets || []).filter(
    (s) => s && Number.isFinite(Number(s.weight)) && Number.isFinite(Number(s.reps)),
  );
  return round1(sets.reduce((acc, s) => acc + Number(s.weight) * Number(s.reps), 0));
}

function lastAvgRir(session) {
  const sets = (session?.sets || []).filter((s) => s && Number.isFinite(Number(s.rir)));
  if (sets.length === 0) return null;
  return round1(sets.reduce((acc, s) => acc + Number(s.rir), 0) / sets.length);
}

function isStalled(ex) {
  const sessions = ex.sessions || [];
  if (sessions.length < 4) return false;
  const last = sessions[sessions.length - 1];
  const ref = sessions[sessions.length - 4];
  return bestE1RM(last) <= bestE1RM(ref) && firstSetWeight(last) <= firstSetWeight(ref);
}

function shortDate(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function computePRs(ex) {
  const sessions = ex.sessions || [];
  let e1 = { v: 0, ts: 0 };
  let weight = { v: 0, ts: 0 };
  let volume = { v: 0, ts: 0 };
  for (const s of sessions) {
    const e = bestE1RM(s);
    if (e > e1.v) e1 = { v: e, ts: s.ts };
    const vol = sessionVolume(s);
    if (vol > volume.v) volume = { v: vol, ts: s.ts };
    for (const set of s.sets || []) {
      const w = Number(set.weight);
      if (Number.isFinite(w) && w > weight.v) weight = { v: w, ts: s.ts };
    }
  }
  return { e1rm: e1, weight, volume };
}

function blockInfo(ex) {
  const sessions = ex.sessions || [];
  let deloadIndex = -1;
  for (let i = sessions.length - 1; i >= 1; i--) {
    const prevW = firstSetWeight(sessions[i - 1]);
    const curW = firstSetWeight(sessions[i]);
    if (prevW > 0 && curW <= prevW * 0.9) {
      deloadIndex = i;
      break;
    }
  }
  const sessionsInBlock = sessions.length - 1 - deloadIndex;
  const DELOAD_AFTER = 8;
  return { sessionsInBlock, deloadSuggested: sessionsInBlock >= DELOAD_AFTER };
}

function suggestionFor(ex, ignoreDeload = false) {
  const sessions = ex.sessions || [];
  if (sessions.length === 0) {
    return {
      weight: null,
      reps: ex.repMin,
      reason: 'Primera sesión: elige un peso que puedas mover en el rango',
      kind: 'start',
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
      kind: 'start',
    };
  }
  const repMax = Number(ex.repMax);
  const repMin = Number(ex.repMin);
  const avgRir = lastAvgRir(last);

  // Carga de trabajo: el peso que el usuario sostuvo en la MAYORÍA de sus series
  // (reps dentro/sobre el rango), no un set pesado aislado.
  const lastWeight = sessionWorkingWeight(last, repMin);
  const workingSets = validSets.filter((s) => Number(s.reps) >= repMin);
  const workSets = workingSets.filter((s) => Number(s.weight) === lastWeight);
  const workReps = workSets.length > 0
    ? Math.max(...workSets.map((s) => Number(s.reps)))
    : (workingSets.length > 0 ? Math.max(...workingSets.map((s) => Number(s.reps))) : 0);

  const volNow = sessionVolume(last);
  const volPrev = sessions.length >= 2 ? sessionVolume(sessions[sessions.length - 2]) : null;
  const volumeDropped = volPrev !== null && volPrev > 0 && volNow < volPrev * 0.9;

  const justDeloaded =
    sessions.length >= 2 && lastWeight <= sessionWorkingWeight(sessions[sessions.length - 2], repMin) * 0.9;

  if (!ignoreDeload && isStalled(ex) && !justDeloaded) {
    return {
      weight: round1(lastWeight * 0.9),
      reps: Number.isFinite(repMin) ? repMin : repMax,
      reason: 'Posible estancamiento: haz una descarga (~90% de carga) y luego reconstruye.',
      kind: 'deload',
    };
  }

  if (workingSets.length === 0) {
    return {
      weight: round1(lastWeight * 0.9),
      reps: Number.isFinite(repMin) ? repMin : repMax,
      reason: 'Todas tus series quedaron bajo el mínimo del rango: baja la carga para trabajar dentro del rango.',
      kind: 'reduce',
    };
  }

  const hitTop = workSets.length > 0 && workSets.every((s) => Number(s.reps) >= repMax);

  if (hitTop && !volumeDropped) {
    const increment = Number.isFinite(Number(ex.incrementKg)) ? Number(ex.incrementKg) : 0;
    let reason = `Llegaste al tope del rango (${repMax} reps). Sube la carga.`;
    if (avgRir !== null && avgRir < 1) {
      reason += ` Estás muy cerca del fallo (RIR ${avgRir}): cuida la recuperación.`;
    }
    return {
      weight: round1(lastWeight + increment),
      reps: Number.isFinite(repMin) ? repMin : repMax,
      reason,
      kind: 'hit_top',
    };
  }

  let reps = Math.min((workReps > 0 ? workReps : repMin) + 1, repMax);
  let reason = `Mantén el peso y completa ${repMax} reps en todas las series antes de subir la carga.`;
  if (hitTop && volumeDropped) {
    reps = repMax;
    reason = 'Llegaste al tope, pero tu volumen bajó esta sesión (probaste un peso que no sostuviste). Mantené la carga y recuperá el volumen antes de subir.';
  } else if (avgRir !== null && avgRir >= 3) {
    reps = repMax;
    reason = `Tu esfuerzo fue bajo (RIR ${avgRir}): sube directo a ${repMax} reps en todas las series.`;
  } else if (avgRir !== null && avgRir < 1) {
    reason += ` Estás llegando al fallo siempre (RIR ${avgRir}): deja 1-2 reps en reserva para recuperarte.`;
  }
  return {
    weight: round1(lastWeight),
    reps,
    reason,
    kind: 'add_reps',
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

function isValidEmail(value) {
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

function passwordChecks(pw) {
  return {
    length: pw.length >= 8,
    upper: /[A-ZÁÉÍÓÚÜÑ]/.test(pw),
    number: /\d/.test(pw),
    symbol: /[^A-Za-z0-9\s]/.test(pw),
  };
}

function mapAuthError(err) {
  const m = ((err && err.message) || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'Correo o contraseña incorrectos.';
  if (m.includes('email not confirmed')) return 'Tu correo aún no está confirmado. Revisá tu bandeja de entrada y el spam.';
  if (m.includes('user already registered')) return 'Ya existe una cuenta con ese correo.';
  if (
    m.includes('password should be') ||
    m.includes('password is too weak') ||
    m.includes('at least 8 characters') ||
    m.includes('stronger password')
  ) {
    return 'La contraseña es demasiado débil: usá al menos 8 caracteres con una mayúscula, un número y un símbolo.';
  }
  if (m.includes('new password should be different')) return 'La nueva contraseña debe ser distinta de la anterior.';
  if (m.includes('rate limit') || m.includes('too many requests')) return 'Demasiados intentos. Esperá unos minutos e intentalo de nuevo.';
  if (m.includes('invalid email') || m.includes('unable to validate email')) return 'El correo tiene un formato inválido.';
  if (m.includes('provider') || m.includes('oauth')) return 'No se pudo conectar con Google. Revisá la configuración del proveedor.';
  if (m.includes('expired') && m.includes('session')) return 'Tu sesión expiró. Volvé a iniciar sesión.';
  return GENERIC_AUTH_ERROR;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('tabata');
  const [dark, setDark] = useState(false);
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(THEME_KEY);
        if (raw === 'true' || raw === '"true"') {
          applyTheme(true);
          setDark(true);
        }
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (mounted) {
          setSession(data && data.session ? data.session : null);
        }
      } catch (_) {
        if (mounted) setSession(null);
      } finally {
        if (mounted) setAuthLoading(false);
      }
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
        return;
      }
      setSession(nextSession);
      if (event === 'SIGNED_OUT') {
        setRecoveryMode(false);
        setActiveTab('tabata');
      }
    });

    return () => {
      mounted = false;
      if (authListener && authListener.subscription) {
        authListener.subscription.unsubscribe();
      }
    };
  }, []);

  function toggleDark(next) {
    applyTheme(next);
    setDark(next);
    try {
      AsyncStorage.setItem(THEME_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  if (authLoading) {
    return (
      <View style={styles.app}>
        <View style={styles.authCenter}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.authLoadingText}>Cargando...</Text>
        </View>
      </View>
    );
  }

  if (!session || recoveryMode) {
    return (
      <AuthFlow
        recoveryMode={recoveryMode}
        onRecovered={() => setRecoveryMode(false)}
      />
    );
  }

  return (
    <View style={styles.app}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Impulso Fit</Text>
          <Text style={styles.tagline}>HIIT · Notas · Progresión · Glosario · Ajustes</Text>
        </View>

        <View style={styles.tabBar}>
          <TabButton
            label="HIIT"
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
          <TabButton
            label="Ajustes"
            active={activeTab === 'ajustes'}
            onPress={() => setActiveTab('ajustes')}
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
        <View style={[styles.view, { display: activeTab === 'ajustes' ? 'flex' : 'none' }]}>
          <AjustesScreen
            dark={dark}
            onToggleDark={toggleDark}
            onLogout={() => supabase.auth.signOut()}
            userEmail={session && session.user ? session.user.email : ''}
          />
        </View>
      </View>
    </View>
  );
}

function AuthScaffold({ title, subtitle, children }) {
  return (
    <View style={styles.app}>
      <ScrollView
        style={styles.authScroll}
        contentContainerStyle={styles.authScrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.authCard}>
          <Text style={styles.authBrand}>Impulso Fit</Text>
          {title ? <Text style={styles.authTitle}>{title}</Text> : null}
          {subtitle ? <Text style={styles.authSubtitle}>{subtitle}</Text> : null}
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

function PasswordField({ label, value, onChangeText, show, onToggleShow, placeholder }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.passwordRow}>
        <TextInput
          style={[styles.input, styles.passwordInput]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder || 'Tu contraseña'}
          placeholderTextColor={colors.muted}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoComplete="password"
          accessibilityLabel={label}
        />
        <TouchableOpacity
          style={styles.passwordToggle}
          onPress={onToggleShow}
          accessibilityRole="button"
        >
          <Text style={styles.passwordToggleText}>{show ? 'Ocultar' : 'Ver'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PwReq({ ok, label }) {
  return (
    <View style={styles.pwReqRow}>
      <Text style={[styles.pwReqIcon, ok ? styles.pwReqOk : styles.pwReqNo]}>{ok ? '✓' : '·'}</Text>
      <Text style={styles.pwReqText}>{label}</Text>
    </View>
  );
}

function LoginForm({ onSwitch }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleLogin() {
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('Ingresá tu correo y contraseña.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password,
      });
      if (err) setError(mapAuthError(err));
    } catch (_) {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({ provider: 'google' });
      if (err) setError(mapAuthError(err));
    } catch (_) {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold title="Iniciar sesión" subtitle="Bienvenido de vuelta a Impulso Fit.">
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Correo electrónico</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="tucorreo@ejemplo.com"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          accessibilityLabel="Correo electrónico"
        />
      </View>

      <PasswordField
        label="Contraseña"
        value={password}
        onChangeText={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
      />

      <TouchableOpacity style={styles.linkBtn} onPress={() => onSwitch('forgot')}>
        <Text style={styles.linkBtnText}>¿Olvidaste tu contraseña?</Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.btnPrimary, styles.authSpaced, busy && styles.btnDisabled]}
        onPress={handleLogin}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.btnPrimaryText}>{busy ? 'Entrando...' : 'Entrar'}</Text>
      </TouchableOpacity>

      <View style={styles.authDivider}>
        <View style={styles.authDividerLine} />
        <Text style={styles.authDividerText}>o</Text>
        <View style={styles.authDividerLine} />
      </View>

      <TouchableOpacity
        style={[styles.btnGoogle, busy && styles.btnDisabled]}
        onPress={handleGoogle}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.btnGoogleText}>Continuar con Google</Text>
      </TouchableOpacity>

      <View style={styles.authFooter}>
        <Text style={styles.authFooterText}>¿No tenés cuenta?</Text>
        <TouchableOpacity onPress={() => onSwitch('register')}>
          <Text style={styles.linkBtnText}> Crear cuenta</Text>
        </TouchableOpacity>
      </View>
    </AuthScaffold>
  );
}

function RegisterForm({ onSwitch, onNeedsConfirm }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const checks = passwordChecks(password);
  const emailValid = isValidEmail(email);

  async function handleSubmit() {
    const f = firstName.trim();
    const l = lastName.trim();
    const e = email.trim();
    const c = country.trim();

    if (!f || !l) {
      setError('Ingresá tu nombre y apellido.');
      return;
    }
    if (!emailValid) {
      setError('Ingresá un correo válido.');
      return;
    }
    if (!c) {
      setError('Ingresá tu país.');
      return;
    }
    if (!(checks.length && checks.upper && checks.number && checks.symbol)) {
      setError('La contraseña no cumple los requisitos mínimos.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    if (!accepted) {
      setError('Debés aceptar la política de privacidad.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: e,
        password,
        options: {
          data: {
            first_name: f,
            last_name: l,
            country: c,
          },
        },
      });
      if (err) {
        setError(mapAuthError(err));
        return;
      }
      if (!(data && data.session)) {
        onNeedsConfirm(e);
      }
    } catch (_) {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold title="Crear cuenta" subtitle="Unos datos y ya estás listo.">
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Nombre</Text>
        <TextInput
          style={styles.input}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Tu nombre"
          placeholderTextColor={colors.muted}
          autoCapitalize="words"
          autoComplete="name"
          accessibilityLabel="Nombre"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Apellido</Text>
        <TextInput
          style={styles.input}
          value={lastName}
          onChangeText={setLastName}
          placeholder="Tu apellido"
          placeholderTextColor={colors.muted}
          autoCapitalize="words"
          accessibilityLabel="Apellido"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Correo electrónico</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="tucorreo@ejemplo.com"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          accessibilityLabel="Correo electrónico"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>País</Text>
        <TextInput
          style={styles.input}
          value={country}
          onChangeText={setCountry}
          placeholder="Chile"
          placeholderTextColor={colors.muted}
          autoCapitalize="words"
          accessibilityLabel="País"
        />
      </View>

      <PasswordField
        label="Contraseña"
        value={password}
        onChangeText={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
      />
      <View style={styles.pwRequirements}>
        <PwReq ok={checks.length} label="Al menos 8 caracteres" />
        <PwReq ok={checks.upper} label="Una mayúscula" />
        <PwReq ok={checks.number} label="Un número" />
        <PwReq ok={checks.symbol} label="Un símbolo" />
      </View>

      <PasswordField
        label="Confirmar contraseña"
        value={confirm}
        onChangeText={setConfirm}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        placeholder="Repetí tu contraseña"
      />

      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() => setAccepted((a) => !a)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
      >
        <View style={[styles.checkbox, accepted && styles.checkboxChecked]}>
          {accepted ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>
          Acepto la política de privacidad y el tratamiento de mis datos.
        </Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.btnPrimary, styles.authSpaced, busy && styles.btnDisabled]}
        onPress={handleSubmit}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.btnPrimaryText}>{busy ? 'Creando cuenta...' : 'Crear cuenta'}</Text>
      </TouchableOpacity>

      <View style={styles.authFooter}>
        <Text style={styles.authFooterText}>¿Ya tenés cuenta?</Text>
        <TouchableOpacity onPress={() => onSwitch('login')}>
          <Text style={styles.linkBtnText}> Iniciar sesión</Text>
        </TouchableOpacity>
      </View>
    </AuthScaffold>
  );
}

function ForgotForm({ onSwitch }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  function redirectTo() {
    if (typeof window !== 'undefined' && window.location) {
      return window.location.origin + window.location.pathname;
    }
    return 'http://localhost:4173/';
  }

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Ingresá tu correo.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: redirectTo(),
      });
      if (err) setError(mapAuthError(err));
      else setSent(true);
    } catch (_) {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthScaffold title="Revisá tu correo" subtitle="Te enviamos un enlace para recuperar tu contraseña.">
        <Text style={styles.authNoticeText}>
          Si existe una cuenta con ese correo, vas a recibir un enlace para restablecer tu contraseña.
        </Text>
        <TouchableOpacity
          style={[styles.btnPrimary, styles.authSpaced]}
          onPress={() => onSwitch('login')}
          accessibilityRole="button"
        >
          <Text style={styles.btnPrimaryText}>Volver a iniciar sesión</Text>
        </TouchableOpacity>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold title="Recuperar contraseña" subtitle="Ingresá tu correo y te enviamos un enlace.">
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Correo electrónico</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="tucorreo@ejemplo.com"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          accessibilityLabel="Correo electrónico"
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.btnPrimary, styles.authSpaced, busy && styles.btnDisabled]}
        onPress={handleSubmit}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.btnPrimaryText}>{busy ? 'Enviando...' : 'Enviar enlace'}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.linkBtn} onPress={() => onSwitch('login')}>
        <Text style={styles.linkBtnText}>Volver a iniciar sesión</Text>
      </TouchableOpacity>
    </AuthScaffold>
  );
}

function NewPasswordForm({ onDone, onSwitch }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit() {
    const checks = passwordChecks(password);
    if (!(checks.length && checks.upper && checks.number && checks.symbol)) {
      setError('La contraseña debe tener al menos 8 caracteres, una mayúscula, un número y un símbolo.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) setError(mapAuthError(err));
      else setSuccess(true);
    } catch (_) {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <AuthScaffold title="Contraseña actualizada" subtitle="Ya podés usar tu nueva contraseña.">
        <Text style={styles.authSuccessText}>Tu contraseña fue actualizada correctamente.</Text>
        <TouchableOpacity
          style={[styles.btnPrimary, styles.authSpaced]}
          onPress={onDone}
          accessibilityRole="button"
        >
          <Text style={styles.btnPrimaryText}>Ir a la app</Text>
        </TouchableOpacity>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold title="Nueva contraseña" subtitle="Ingresá y confirmá tu nueva contraseña.">
      <PasswordField
        label="Nueva contraseña"
        value={password}
        onChangeText={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
      />
      <View style={styles.pwRequirements}>
        <PwReq ok={passwordChecks(password).length} label="Al menos 8 caracteres" />
        <PwReq ok={passwordChecks(password).upper} label="Una mayúscula" />
        <PwReq ok={passwordChecks(password).number} label="Un número" />
        <PwReq ok={passwordChecks(password).symbol} label="Un símbolo" />
      </View>

      <PasswordField
        label="Confirmar contraseña"
        value={confirm}
        onChangeText={setConfirm}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        placeholder="Repetí tu nueva contraseña"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.btnPrimary, styles.authSpaced, busy && styles.btnDisabled]}
        onPress={handleSubmit}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.btnPrimaryText}>{busy ? 'Guardando...' : 'Guardar contraseña'}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.linkBtn} onPress={() => onSwitch('login')}>
        <Text style={styles.linkBtnText}>Volver a iniciar sesión</Text>
      </TouchableOpacity>
    </AuthScaffold>
  );
}

function CheckEmail({ email, onSwitch }) {
  return (
    <AuthScaffold title="Revisá tu correo" subtitle="Te enviamos un enlace para confirmar tu cuenta.">
      <Text style={styles.authNoticeText}>
        Te mandamos un correo de confirmación a{' '}
        <Text style={styles.authNoticeEmail}>{email}</Text>. Revisá tu bandeja de entrada (y el spam) y
        seguí el enlace para activar tu cuenta.
      </Text>
      <TouchableOpacity
        style={[styles.btnPrimary, styles.authSpaced]}
        onPress={() => onSwitch('login')}
        accessibilityRole="button"
      >
        <Text style={styles.btnPrimaryText}>Volver a iniciar sesión</Text>
      </TouchableOpacity>
    </AuthScaffold>
  );
}

function AuthFlow({ recoveryMode, onRecovered }) {
  const [mode, setMode] = useState('login');
  const [pendingEmail, setPendingEmail] = useState('');

  useEffect(() => {
    if (recoveryMode) setMode('newPassword');
  }, [recoveryMode]);

  if (mode === 'register') {
    return (
      <RegisterForm
        onSwitch={setMode}
        onNeedsConfirm={(email) => {
          setPendingEmail(email);
          setMode('checkEmail');
        }}
      />
    );
  }
  if (mode === 'forgot') return <ForgotForm onSwitch={setMode} />;
  if (mode === 'newPassword') {
    return <NewPasswordForm onDone={onRecovered} onSwitch={setMode} />;
  }
  if (mode === 'checkEmail') return <CheckEmail email={pendingEmail} onSwitch={setMode} />;
  return <LoginForm onSwitch={setMode} />;
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
  const styles = timerStyles;
  const colors = timerColors;

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
    phaseType === 'ready' ? colors.ready : phaseType === 'rest' ? colors.rest : colors.volt;

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
  const [deloadOffer, setDeloadOffer] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [calibrationOffer, setCalibrationOffer] = useState(null);
  const [noAskCalibration, setNoAskCalibration] = useState(false);

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
      try {
        const flag = await AsyncStorage.getItem(CALIBRATION_KEY);
        if (flag === 'true') setNoAskCalibration(true);
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
    const sug = suggestionFor(ex, true);
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
    if (!noAskCalibration) {
      setCalibrationOffer({ exerciseId: ex.id, goal: ex.goal, repMin: ex.repMin, repMax: ex.repMax, incrementKg: ex.incrementKg });
    }
  }

  function applyCalibration(weight, reps) {
    if (!calibrationOffer) return;
    const { exerciseId } = calibrationOffer;
    setDrafts((prev) => {
      const cur = prev[exerciseId] || { weight: '', reps: '', rir: 2, sets: [] };
      return { ...prev, [exerciseId]: { ...cur, weight: String(weight), reps: String(reps) } };
    });
    setCalibrationOffer(null);
  }

  function dontAskCalibration() {
    setNoAskCalibration(true);
    try {
      AsyncStorage.setItem(CALIBRATION_KEY, 'true');
    } catch (_) {}
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

    const nextSug = suggestionFor(updatedEx);
    if (nextSug.kind === 'deload') {
      setDeloadOffer({ exerciseId: ex.id, weight: nextSug.weight, reps: nextSug.reps });
    }
  }

  function acceptDeload() {
    if (!deloadOffer) return;
    const { exerciseId, weight, reps } = deloadOffer;
    setDrafts((prev) => {
      const cur = prev[exerciseId] || { weight: '', reps: '', rir: 2, sets: [] };
      return { ...prev, [exerciseId]: { ...cur, weight: String(weight), reps: String(reps) } };
    });
    setDeloadOffer(null);
  }

  function declineDeload() {
    setDeloadOffer(null);
  }

  function confirmDelete() {
    if (deleteTarget) deleteExercise(deleteTarget);
    setDeleteTarget(null);
  }

  function cancelDelete() {
    setDeleteTarget(null);
  }

  return (
    <>
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
              onDelete={() => setDeleteTarget(ex.id)}
              onDeloadInfo={(weight, reps) => setDeloadOffer({ exerciseId: ex.id, weight, reps })}
            />
          ))
        )}
      </View>
      </ScrollView>

      <Modal
        visible={!!deloadOffer}
        transparent
        animationType="fade"
        onRequestClose={declineDeload}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>¿Descarga (deload)?</Text>
            <Text style={styles.modalBody}>
              Tu progreso se estancó. Una semana de descarga (bajar la carga a {deloadOffer?.weight} kg) ayuda a recuperar la fatiga acumulada y volver más fuerte.
            </Text>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.btn, styles.modalGhost]} onPress={declineDeload}>
                <Text style={styles.btnGhostText}>No, continuar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btnPrimary, styles.modalPrimary]} onPress={acceptDeload}>
                <Text style={styles.btnPrimaryText}>Sí, ajustar carga</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!deleteTarget}
        transparent
        animationType="fade"
        onRequestClose={cancelDelete}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>¿Eliminar ejercicio?</Text>
            <Text style={styles.modalBody}>
              Se borrará el ejercicio y todo su historial. Esta acción no se puede deshacer.
            </Text>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.btn, styles.modalGhost]} onPress={cancelDelete}>
                <Text style={styles.btnGhostText}>No, mantener</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btnPrimary, styles.modalPrimary, styles.dangerBtnSolid]} onPress={confirmDelete}>
                <Text style={styles.btnPrimaryText}>Sí, eliminar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <CalibrationModal
        visible={!!calibrationOffer}
        goal={calibrationOffer?.goal}
        repMin={calibrationOffer?.repMin}
        repMax={calibrationOffer?.repMax}
        incrementKg={calibrationOffer?.incrementKg}
        onApply={applyCalibration}
        onClose={() => setCalibrationOffer(null)}
        onDontAsk={dontAskCalibration}
      />
    </>
  );
}

function ExerciseCard({ exercise, draft, onField, onAddSet, onRemoveSet, onFinish, onDelete, onDeloadInfo }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const sug = suggestionFor(exercise);
  const weightVal = draft.weight;
  const repsVal = draft.reps;
  const rir = draft.rir;
  const sets = draft.sets || [];

  const sessions = exercise.sessions || [];
  const hasChart = sessions.length >= 2;
  const recent = hasChart ? sessions.slice(-6).map((s) => bestE1RM(s)) : [];
  const chartMax = recent.length > 0 ? Math.max(...recent) : 0;
  const fullHistory = sessions.slice().reverse().map((s) => ({
    ts: s.ts,
    e1rm: bestE1RM(s),
    weight: firstSetWeight(s),
    vol: sessionVolume(s),
    setCount: s.sets.length,
    firstReps: s.sets[0]?.reps ?? 0,
  }));

  let lastSummary = null;
  let isPR = false;
  let isStall = false;
  let historyNote = '';
  let volumeNote = null;
  let block = { sessionsInBlock: 0, deloadSuggested: false };
  let prs = { e1rm: { v: 0, ts: 0 }, weight: { v: 0, ts: 0 }, volume: { v: 0, ts: 0 } };
  if (sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    const best = bestE1RM(last);
    const setCount = last.sets.length;
    const firstReps = last.sets[0]?.reps ?? 0;
    const firstWeight = firstSetWeight(last);
    const vol = sessionVolume(last);
    const avgRir = lastAvgRir(last);
    lastSummary = `${setCount}×${firstReps} @ ${firstWeight} kg · e1RM ${best} kg · Vol ${vol} kg${avgRir !== null ? ` · RIR ${avgRir}` : ''}`;

    if (sessions.length >= 2) {
      const prevVol = sessionVolume(sessions[sessions.length - 2]);
      if (prevVol > 0) {
        const delta = Math.round(((vol - prevVol) / prevVol) * 100);
        volumeNote = delta >= 0
          ? `Volumen +${delta}% vs sesión anterior`
          : `Volumen ${delta}% vs sesión anterior`;
      }
    }

    if (sessions.length >= 2) {
      const prevBest = Math.max(...sessions.slice(0, -1).map((s) => bestE1RM(s)));
      isPR = best > prevBest;
    }
    if (sessions.length >= 4) {
      const prev = sessions[sessions.length - 4];
      isStall = best <= bestE1RM(prev) && firstWeight <= firstSetWeight(prev);
    }

    block = blockInfo(exercise);
    prs = computePRs(exercise);

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
        <TouchableOpacity style={styles.exerciseTitleBtn} onPress={() => setCollapsed((v) => !v)}>
          <View style={styles.exerciseTitleWrap}>
            <Text style={styles.exerciseName}>{exercise.name}</Text>
            <View style={styles.goalBadge}>
              <Text style={styles.goalBadgeText}>
                {exercise.goal === 'fuerza' ? 'Fuerza' : 'Hipertrofia'}
              </Text>
            </View>
          </View>
          <Text style={styles.chevron}>{collapsed ? '▸' : '▾'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnSmallGhost} onPress={onDelete}>
          <Text style={styles.btnSmallGhostText}>Eliminar</Text>
        </TouchableOpacity>
      </View>

      {!collapsed ? (
        <>
      <View style={styles.sugBox}>
        <Text style={styles.sugLine}>
          {sug.weight !== null
            ? `${sug.weight} kg × ${sug.reps} reps`
            : `Primera sesión: elige un peso y haz ${exercise.repMin} reps`}
        </Text>
        <Text style={styles.sugReason}>{sug.reason}</Text>
        {sug.kind === 'deload' ? (
          <TouchableOpacity style={styles.linkBtn} onPress={() => onDeloadInfo(sug.weight, sug.reps)}>
            <Text style={styles.linkBtnText}>Ver por qué descargar</Text>
          </TouchableOpacity>
        ) : null}
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
          {volumeNote ? <Text style={styles.historyMeta}>{volumeNote}</Text> : null}
          {isPR ? <Text style={styles.prText}>🏆 Nuevo PR de e1RM</Text> : null}
          {isStall ? (
            <Text style={styles.stallText}>
              Posible estancamiento: descarga a {round1(firstSetWeight(exercise.sessions[exercise.sessions.length - 1]) * 0.9)} kg y reconstruye.
            </Text>
          ) : null}
          <Text style={styles.historyMeta}>Bloque actual: sesión {block.sessionsInBlock}</Text>
          {block.deloadSuggested ? (
            <Text style={styles.stallText}>
              Fin de bloque sugerido: considera una semana de descarga (~90% de carga).
            </Text>
          ) : null}
          {prs.e1rm.v > 0 ? (
            <View style={styles.prBox}>
              <Text style={styles.historyTitle}>Mejor marca</Text>
              <Text style={styles.historyMeta}>
                🏆 e1RM {prs.e1rm.v} kg ({shortDate(prs.e1rm.ts)}) · Peso máx {prs.weight.v} kg ({shortDate(prs.weight.ts)}) · Volumen {prs.volume.v} kg ({shortDate(prs.volume.ts)})
              </Text>
            </View>
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

          <TouchableOpacity style={styles.linkBtn} onPress={() => setShowFullHistory((v) => !v)}>
            <Text style={styles.linkBtnText}>
              {showFullHistory ? 'Ocultar historial completo' : 'Ver historial completo'}
            </Text>
          </TouchableOpacity>
          {showFullHistory ? (
            <View style={styles.historyList}>
              {fullHistory.map((h) => (
                <View key={h.ts} style={styles.historyItem}>
                  <Text style={styles.historyDate}>{shortDate(h.ts)}</Text>
                  <Text style={styles.historyItemText}>
                    {h.setCount}×{h.firstReps} @ {h.weight} kg · e1RM {h.e1rm} kg · Vol {h.vol} kg
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
        </>
      ) : (
        lastSummary ? <Text style={styles.collapsedHint}>Última: {lastSummary}</Text> : null
      )}
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

function AjustesScreen({ dark, onToggleDark, onLogout, userEmail }) {
  const [status, setStatus] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  async function resetAll() {
    if (!confirmReset) {
      setConfirmReset(true);
      setStatus('¿Seguro? Toca de nuevo para confirmar.');
      setTimeout(() => setConfirmReset(false), 5000);
      return;
    }
    try {
      await AsyncStorage.multiRemove([CONFIG_KEY, NOTES_KEY, PROGRESION_KEY]);
      setConfirmReset(false);
      setStatus('Datos borrados. Recarga la app.');
    } catch (_) {
      setStatus('No se pudo borrar.');
    }
  }

  async function logout() {
    setStatus('Cerrando sesión...');
    try {
      await onLogout();
    } catch (_) {
      setStatus('No se pudo cerrar la sesión.');
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Ajustes</Text>

        <Text style={styles.sectionTitle}>Apariencia</Text>
        <TouchableOpacity
          style={styles.settingRow}
          onPress={() => onToggleDark(!dark)}
        >
          <View style={styles.settingTextWrap}>
            <Text style={styles.settingTitle}>Modo oscuro</Text>
            <Text style={styles.settingHint}>Colores oscuros, más cómodos con poca luz.</Text>
          </View>
          <View style={[styles.switch, dark && styles.switchOn]}>
            <View style={[styles.switchKnob, dark && styles.switchKnobOn]} />
          </View>
        </TouchableOpacity>

        <Text style={[styles.fieldLabel, styles.topGap]}>Sesión</Text>
        {userEmail ? (
          <Text style={styles.settingHint}>Sesión iniciada como {userEmail}</Text>
        ) : null}
        <TouchableOpacity style={[styles.btn, styles.logoutBtn]} onPress={logout}>
          <Text style={styles.logoutBtnText}>Cerrar sesión</Text>
        </TouchableOpacity>

        <Text style={[styles.fieldLabel, styles.topGap]}>Zona de peligro</Text>
        <TouchableOpacity style={[styles.btn, styles.dangerBtn]} onPress={resetAll}>
          <Text style={styles.dangerBtnText}>
            {confirmReset ? 'Toca de nuevo para confirmar' : 'Borrar todos los datos'}
          </Text>
        </TouchableOpacity>

        {status ? <Text style={styles.statusText}>{status}</Text> : null}
      </View>
    </ScrollView>
  );
}

function CalibrationModal({ visible, goal, repMin, repMax, incrementKg, onApply, onClose, onDontAsk }) {
  const [step, setStep] = useState('ask');
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [rir, setRir] = useState(0);
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    if (visible) {
      setStep('ask');
      setWeight('');
      setReps('');
      setRir(0);
      setDontAsk(false);
    }
  }, [visible]);

  function calculate() {
    const w = parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(r) || r < 1) return;
    // Reps efectivas: sumamos las que quedaron en reserva para estimar el 1RM
    // como si la serie se hubiera hecho cerca del fallo (más preciso).
    const effectiveReps = Math.min(r + rir, 12);
    const e1rm = epley(w, effectiveReps);
    const factor = goal === 'fuerza' ? 0.8 : 0.7;
    const inc = Number.isFinite(incrementKg) && incrementKg > 0 ? incrementKg : 2.5;
    // Redondeamos al disco más cercano (p. ej. 2.5 kg) para un peso real de gimnasio.
    const raw = e1rm * factor;
    // Nunca dejamos el peso en 0: si el cálculo cae bajo el disco mínimo, usamos ese disco.
    const startWeight = round1(Math.max(inc, Math.round(raw / inc) * inc));
    const startReps = repMin;
    if (dontAsk) onDontAsk();
    onApply(startWeight, startReps);
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          {step === 'ask' ? (
            <>
              <Text style={styles.modalTitle}>¿Prueba de punto de partida?</Text>
              <Text style={styles.modalBody}>
                Esta prueba mide tu punto de partida: haz una serie con un peso cómodo y anota cuántas reps lograste. Con eso calculamos tu carga inicial.
              </Text>
              <TouchableOpacity style={styles.checkboxRow} onPress={() => setDontAsk((v) => !v)}>
                <View style={[styles.checkbox, dontAsk && styles.checkboxChecked]}>
                  {dontAsk ? <Text style={styles.checkboxMark}>✓</Text> : null}
                </View>
                <Text style={styles.checkboxText}>No volver a mostrar este mensaje</Text>
              </TouchableOpacity>
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.modalGhost]}
                  onPress={() => { if (dontAsk) onDontAsk(); onClose(); }}
                >
                  <Text style={styles.btnGhostText}>No, gracias</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btnPrimary, styles.modalPrimary]} onPress={() => setStep('test')}>
                  <Text style={styles.btnPrimaryText}>Sí, hacer prueba</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.modalTitle}>Prueba de punto de partida</Text>
              <Text style={styles.modalBody}>
                Elegí un peso que te permita hacer entre 5 y 10 reps con buena técnica, cerca del fallo. Anotá cuántas hiciste y cuántas más calculás que te quedaban.
              </Text>
              <View style={styles.inputRow}>
                <View style={styles.inputCol}>
                  <Text style={styles.inputUnitLabel}>Peso (kg)</Text>
                  <TextInput
                    style={styles.input}
                    value={weight}
                    onChangeText={(t) => setWeight(t.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor="#9ca3af"
                  />
                </View>
                <View style={styles.inputCol}>
                  <Text style={styles.inputUnitLabel}>Reps logradas</Text>
                  <TextInput
                    style={styles.input}
                    value={reps}
                    onChangeText={(t) => {
                      const n = t.replace(/\D/g, '');
                      if (n === '' || (Number(n) >= 1 && Number(n) <= 12)) setReps(n);
                    }}
                    keyboardType="number-pad"
                    placeholder="0"
                    placeholderTextColor="#9ca3af"
                  />
                </View>
              </View>
              <Text style={styles.fieldLabel}>Reps que te quedaron en reserva (RIR)</Text>
              <View style={styles.rirRow}>
                {[
                  { label: '0', sub: 'al fallo', value: 0 },
                  { label: '1-2', sub: 'cerca', value: 1 },
                  { label: '3+', sub: 'cómodo', value: 3 },
                ].map((opt) => (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.goalChip, rir === opt.value && styles.goalChipActive]}
                    onPress={() => setRir(opt.value)}
                  >
                    <Text style={[styles.goalChipText, rir === opt.value && styles.goalChipTextActive]}>
                      {opt.label}
                    </Text>
                    <Text style={[styles.goalChipSub, rir === opt.value && styles.goalChipTextActive]}>
                      {opt.sub}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.fieldHint}>
                Se registran hasta 12 reps: la fórmula de Epley deja de ser fidedigna por sobre ese número.
              </Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={[styles.btn, styles.modalGhost]} onPress={() => setStep('ask')}>
                  <Text style={styles.btnGhostText}>Volver</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btnPrimary, styles.modalPrimary]} onPress={calculate}>
                  <Text style={styles.btnPrimaryText}>Calcular y aplicar</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles() {
  return StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: colors.bg,
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
    color: colors.text,
  },
  tagline: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.panel,
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: colors.accent,
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.muted,
  },
  tabTextActive: {
    color: colors.onAccent,
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
    backgroundColor: colors.panel,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 16,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  fieldHint: {
    fontSize: 12,
    color: colors.muted,
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
    color: colors.muted,
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
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
  },
  soundChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  soundChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
  soundChipTextActive: {
    color: colors.onAccent,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnPrimaryText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '700',
  },
  btn: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderColor: colors.border,
  },
  btnGhostText: {
    color: colors.ghost,
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: colors.danger,
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
    fontSize: 92,
    fontWeight: '800',
    color: colors.text,
    marginTop: 8,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  seriesCounter: {
    fontSize: 15,
    color: colors.muted,
    marginTop: 4,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.bg,
    overflow: 'hidden',
    marginTop: 24,
    marginBottom: 24,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.volt,
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
    color: colors.muted,
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
    color: colors.muted,
    lineHeight: 20,
  },
  noteCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    backgroundColor: colors.bg,
  },
  noteTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    paddingVertical: 4,
  },
  noteBody: {
    fontSize: 14,
    color: colors.text,
    minHeight: 64,
    textAlignVertical: 'top',
    paddingVertical: 4,
  },
  noteMeta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 8,
  },
  noteActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  formPanel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    backgroundColor: colors.bg,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
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
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
  },
  goalChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  goalChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
  goalChipTextActive: {
    color: colors.onAccent,
  },
  goalChipSub: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.muted,
    marginTop: 2,
  },
  rirRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
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
    color: colors.text,
  },
  goalBadge: {
    backgroundColor: colors.softBg,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.softBorder,
  },
  goalBadgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  btnSmallGhost: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  btnSmallGhostText: {
    color: colors.ghost,
    fontSize: 12,
    fontWeight: '600',
  },
  sugBox: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sugLine: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  sugReason: {
    fontSize: 13,
    color: colors.muted,
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
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
  },
  rirChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  rirChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  rirChipTextActive: {
    color: colors.onAccent,
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
    borderBottomColor: colors.border,
  },
  seriesText: {
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  finishBtn: {
    marginTop: 12,
  },
  historyBox: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  historyTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  historyLine: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '600',
  },
  historyNote: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 19,
    marginBottom: 6,
  },
  prText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ready,
    marginTop: 6,
  },
  stallText: {
    fontSize: 13,
    color: colors.danger,
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
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  chartLabel: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 4,
  },
  glossaryCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    backgroundColor: colors.bg,
  },
  glossaryTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  glossaryText: {
    fontSize: 13,
    color: colors.muted,
    lineHeight: 19,
  },
  historyMeta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 6,
    lineHeight: 17,
  },
  prBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.prBg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  textArea: {
    minHeight: 120,
    textAlignVertical: 'top',
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dangerBtn: {
    borderColor: colors.danger,
    backgroundColor: 'transparent',
  },
  dangerBtnText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  statusText: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 12,
    lineHeight: 18,
  },
  topGap: {
    marginTop: 16,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  settingTextWrap: {
    flex: 1,
    paddingRight: 12,
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  settingHint: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
  switch: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.border,
    padding: 3,
    justifyContent: 'center',
  },
  switchOn: {
    backgroundColor: colors.accent,
  },
  switchKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ffffff',
  },
  switchKnobOn: {
    alignSelf: 'flex-end',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.panel,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 10,
  },
  modalBody: {
    fontSize: 14,
    color: colors.muted,
    lineHeight: 20,
    marginBottom: 18,
  },
  modalGhost: {
    flex: 1,
  },
  modalPrimary: {
    flex: 1,
  },
  dangerBtnSolid: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checkboxMark: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '700',
  },
  checkboxText: {
    flex: 1,
    fontSize: 13,
    color: colors.muted,
    lineHeight: 18,
  },
  linkBtn: {
    marginTop: 8,
    paddingVertical: 6,
  },
  linkBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },
  exerciseTitleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 6,
  },
  chevron: {
    fontSize: 16,
    color: colors.muted,
    marginLeft: 2,
  },
  collapsedHint: {
    fontSize: 13,
    color: colors.muted,
    paddingVertical: 10,
  },
  historyList: {
    marginTop: 8,
    gap: 6,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  historyDate: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    minWidth: 44,
  },
  historyItemText: {
    fontSize: 13,
    color: colors.text,
    flex: 1,
  },
  authCenter: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  authLoadingText: {
    fontSize: 14,
    color: colors.muted,
  },
  authScroll: {
    flex: 1,
    width: '100%',
  },
  authScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    padding: 16,
    paddingVertical: 32,
  },
  authCard: {
    width: '100%',
    maxWidth: 420,
    marginTop: 'auto',
    marginBottom: 'auto',
    backgroundColor: colors.panel,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  authBrand: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
  },
  authTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginTop: 12,
    textAlign: 'center',
  },
  authSubtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 4,
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 18,
  },
  authSpaced: {
    marginTop: 16,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  passwordInput: {
    flex: 1,
    minWidth: 0,
  },
  passwordToggle: {
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  passwordToggleText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },
  pwRequirements: {
    marginTop: -6,
    marginBottom: 14,
    gap: 4,
  },
  pwReqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pwReqIcon: {
    fontSize: 12,
    width: 14,
    textAlign: 'center',
    fontWeight: '700',
  },
  pwReqOk: {
    color: colors.accent,
  },
  pwReqNo: {
    color: colors.ghost,
  },
  pwReqText: {
    fontSize: 12,
    color: colors.muted,
  },
  authDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  authDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  authDividerText: {
    fontSize: 12,
    color: colors.muted,
  },
  btnGoogle: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  btnGoogleText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  authFooter: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
    flexWrap: 'wrap',
  },
  authFooterText: {
    fontSize: 13,
    color: colors.muted,
  },
  authNoticeText: {
    fontSize: 14,
    color: colors.muted,
    lineHeight: 20,
  },
  authNoticeEmail: {
    fontWeight: '700',
    color: colors.text,
  },
  authSuccessText: {
    fontSize: 14,
    color: colors.accent,
    lineHeight: 20,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  logoutBtn: {
    borderColor: colors.danger,
    backgroundColor: 'transparent',
    marginTop: 8,
  },
  logoutBtnText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  });
}

let colors = THEMES.light;
let styles = makeStyles();
let timerColors = TIMER_COLORS;
let timerStyles = (() => {
  const prev = colors;
  colors = TIMER_COLORS;
  const s = makeStyles();
  colors = prev;
  return s;
})();

function applyTheme(dark) {
  colors = dark ? THEMES.dark : THEMES.light;
  styles = makeStyles();
}
