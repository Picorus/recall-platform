// The rider app (P4). P4.1: language, sign-in with a code, and who is signed in. The screens are a
// small set of steps, so the app moves between them itself (no navigation library); Android's back
// button goes back a step.
import { RIDER_LANGUAGES, type RiderLanguage } from '@recall/domain';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiError, call, type Me } from './src/api';
import { Code } from './src/screens/Code';
import { Home } from './src/screens/Home';
import { SignIn, type CodeSent } from './src/screens/SignIn';
import { stored } from './src/storage';
import { FONT_FILES } from './src/fonts';
import { color } from './src/theme';
import { LangContext } from './src/ui';

type Step =
  | { readonly at: 'loading' }
  | { readonly at: 'sign-in'; readonly phone: string }
  | { readonly at: 'code'; readonly sent: CodeSent }
  | { readonly at: 'home'; readonly token: string; readonly me: Me };

export default function App() {
  const [lang, setLang] = useState<RiderLanguage>('en');
  const [step, setStep] = useState<Step>({ at: 'loading' });
  // The faces are inside the app: ready at once (a failure still shows the app, in the phone's own face).
  const [fontsReady, fontsFailed] = useFonts(FONT_FILES);

  const enter = useCallback(async (token: string) => {
    try {
      const me = await call<Me>('/rider/me', { token });
      setStep({ at: 'home', token, me });
    } catch (e) {
      // Signed out elsewhere (or the session ran out): sign in again. No connection: try again.
      if (e instanceof ApiError && e.status === 401) await stored.setToken(null);
      setStep({ at: 'sign-in', phone: '' });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const l = await stored.language();
      if (l && (RIDER_LANGUAGES as readonly string[]).includes(l)) setLang(l as RiderLanguage);
      const token = await stored.token();
      if (token) await enter(token);
      else setStep({ at: 'sign-in', phone: '' });
    })().catch(() => setStep({ at: 'sign-in', phone: '' }));
  }, [enter]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step.at === 'code') {
        setStep({ at: 'sign-in', phone: step.sent.shown.replace(/^\+91\s*/, '') });
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step]);

  const chooseLanguage = (l: RiderLanguage) => {
    setLang(l);
    void stored.setLanguage(l);
  };

  const signOut = async () => {
    if (step.at !== 'home') return;
    // Ended on the server too; signed out here even if the phone is offline.
    await call('/rider/sign-out', { body: {}, token: step.token }).catch(() => undefined);
    await stored.setToken(null);
    setStep({ at: 'sign-in', phone: '' });
  };

  return (
    <SafeAreaProvider>
      <LangContext.Provider value={lang}>
        <StatusBar style="light" />
        {(step.at === 'loading' || (!fontsReady && !fontsFailed)) && (
          <View style={{ flex: 1, backgroundColor: color.ground, justifyContent: 'center' }}>
            <ActivityIndicator color={color.volt} />
          </View>
        )}
        {(fontsReady || fontsFailed) && step.at === 'sign-in' && (
          <SignIn
            lang={lang}
            onLanguage={chooseLanguage}
            initialPhone={step.phone}
            onSent={(sent) => setStep({ at: 'code', sent })}
          />
        )}
        {(fontsReady || fontsFailed) && step.at === 'code' && (
          <Code
            lang={lang}
            sent={step.sent}
            onResent={(sent) => setStep({ at: 'code', sent })}
            onChangeNumber={() =>
              setStep({ at: 'sign-in', phone: step.sent.shown.replace(/^\+91\s*/, '') })
            }
            onSignedIn={(token) => {
              void stored.setToken(token).then(() => enter(token));
            }}
          />
        )}
        {(fontsReady || fontsFailed) && step.at === 'home' && (
          <Home lang={lang} me={step.me} onSignOut={() => void signOut()} />
        )}
      </LangContext.Provider>
    </SafeAreaProvider>
  );
}
