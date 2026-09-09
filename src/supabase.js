import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ltmdsxnhjbwmlldnfblh.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0bWRzeG5oamJ3bWxsZG5mYmxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NTUwNDAsImV4cCI6MjEwNDUzMTA0MH0.ewJ-mAW1w5CT2sVuuGYXDj0DUKQecpsUrsb9eJQNLjw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
