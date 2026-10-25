import * as React from "react";
import * as THREE from "three";

export type ThemeMode = "light" | "dark" | "auto";

export function useShadcnTheme(theme: ThemeMode = "auto"): {
  primaryColor: THREE.Color;
  accentColor: THREE.Color;
} {
  const [colors, setColors] = React.useState<{
    primaryColor: THREE.Color;
    accentColor: THREE.Color;
  }>(() => ({
    primaryColor: new THREE.Color("#7c5cff"),
    accentColor: new THREE.Color("#5b8cff"),
  }));

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const resolveColors = () => {
      const isDark =
        theme === "dark" ||
        (theme === "auto" &&
          (document.documentElement.classList.contains("dark") ||
            window.matchMedia("(prefers-color-scheme: dark)").matches ||
            true));

      const styles = getComputedStyle(document.documentElement);
      const rawPrimary = styles.getPropertyValue("--primary").trim();
      const rawAccent = styles.getPropertyValue("--accent").trim();

      const parseColor = (val: string, fallback: string) => {
        if (!val) return new THREE.Color(fallback);
        try {
          return new THREE.Color(val);
        } catch {
          return new THREE.Color(fallback);
        }
      };

      const fallbackPrimary = isDark ? "#7c5cff" : "#4f46e5";
      const fallbackAccent = isDark ? "#5b8cff" : "#06b6d4";

      setColors({
        primaryColor: parseColor(rawPrimary, fallbackPrimary),
        accentColor: parseColor(rawAccent, fallbackAccent),
      });
    };

    resolveColors();

    const observer = new MutationObserver(resolveColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => observer.disconnect();
  }, [theme]);

  return colors;
}
