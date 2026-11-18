// App entry. The background task must be defined at startup even when the OS
// launches the app in the background with no UI, so it's imported here, before
// expo-router's entry (which only loads screens when it renders them).
import './polyfills';
import './src/background';
import 'expo-router/entry';
