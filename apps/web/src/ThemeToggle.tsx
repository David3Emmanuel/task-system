import { useTheme, type Theme } from './useTheme';

const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const ICON: Record<Theme, string> = { system: '🖥️', light: '☀️', dark: '🌙' };
const LABEL: Record<Theme, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(NEXT[theme])}
      title={`${LABEL[theme]} — click to change`}
      aria-label="Toggle color theme"
    >
      {ICON[theme]}
    </button>
  );
}
