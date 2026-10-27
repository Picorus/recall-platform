// What the app keeps on the phone (P4.1): the session token in the phone's secure store (encrypted
// by Android), and the chosen language. On the web build (tests only) the browser's storage.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const web = Platform.OS === 'web';

async function get(key: string): Promise<string | null> {
  if (web) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function set(key: string, value: string | null): Promise<void> {
  if (web) {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      // Private mode: nothing kept; the rider signs in again next time.
    }
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

export const stored = {
  token: () => get('recall.token'),
  setToken: (t: string | null) => set('recall.token', t),
  language: () => get('recall.language'),
  setLanguage: (l: string) => set('recall.language', l),
};
