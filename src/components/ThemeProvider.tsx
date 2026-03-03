"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

// 1. Create a context for our custom color themes
const ColorThemeContext = React.createContext<{
  colorTheme: string;
  setColorTheme: (theme: string) => void;
}>({ colorTheme: 'default', setColorTheme: () => {} });

// 2. Export a hook so any component can use/change the theme
export function useColorTheme() {
  return React.useContext(ColorThemeContext);
}

export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  const [colorTheme, setColorThemeState] = React.useState('default');

  // Load the saved theme on mount
  React.useEffect(() => {
    const savedTheme = localStorage.getItem('omnibus-color-theme') || 'default';
    setColorThemeState(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  // Handle changing and saving the theme
  const setColorTheme = (theme: string) => {
    setColorThemeState(theme);
    localStorage.setItem('omnibus-color-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  };

  return (
    <NextThemesProvider {...props}>
      <ColorThemeContext.Provider value={{ colorTheme, setColorTheme }}>
        {children}
      </ColorThemeContext.Provider>
    </NextThemesProvider>
  )
}