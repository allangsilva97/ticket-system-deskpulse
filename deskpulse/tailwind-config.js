// Tailwind Play CDN settings (kept in a file because the page policy forbids inline scripts).
tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
            colors: {
                // Full scale: the original only defined 50/100/500/600/700, so classes such as
                // dark:text-brand-400 and dark:bg-brand-900/40 silently generated no CSS.
                brand: {
                    50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8',
                    500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b'
                }
            }
        }
    }
};
