// Pictures bundled into the app by Metro (the night pictures from packages/design).
declare module '*.webp' {
  import type { ImageSourcePropType } from 'react-native';
  const source: ImageSourcePropType;
  export default source;
}
