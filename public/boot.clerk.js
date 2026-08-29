/* TraxWax — Clerk appearance (S2 / S3)
   "TraxWax chrome, stock card": we own the frame, Clerk owns the form. Variables and a
   short element list only — no CSS-in-JS reimplementation of their internals, so a Clerk
   update can restyle their guts without breaking our page.

   MERGE into boot.js's Clerk.load() call, alongside the existing signInUrl / signUpUrl /
   fallback options. Do not replace them.

   Reference: clerk.com/docs/customization/overview — `variables` + `elements`.  */

export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#e8194b',          /* --accent (light). See the note below re: dark. */
    colorText: '#16171a',             /* --ink */
    colorTextSecondary: '#54585f',    /* --muted */
    colorBackground: '#ffffff',       /* --panel */
    colorInputBackground: '#ffffff',
    colorInputText: '#16171a',
    colorDanger: '#e8194b',
    fontFamily: "'IBM Plex Mono', monospace",
    fontFamilyButtons: "'IBM Plex Mono', monospace",
    fontSize: '12px',
    borderRadius: '0px',              /* radius is 0 everywhere, by design */
    spacingUnit: '1rem',
  },
  elements: {
    /* We draw the card; theirs must be invisible inside ours. */
    rootBox: { width: '100%' },
    card: {
      boxShadow: 'none', border: 'none', background: 'transparent',
      padding: '0', width: '100%',
    },
    /* Our stateCard() supplies kicker + headline, so Clerk's own header is duplication. */
    header: { display: 'none' },
    /* Their footer offers "Don't have an account?"; ours does, in our type. */
    footer: { display: 'none' },
    formFieldLabel: {
      fontFamily: "'IBM Plex Mono', monospace", fontSize: '9.5px', fontWeight: '700',
      letterSpacing: '.16em', textTransform: 'uppercase', color: '#54585f',
    },
    formFieldInput: {
      border: '1.5px solid #16171a', borderRadius: '0', fontSize: '12px',
      padding: '10px 11px', boxShadow: 'none',
    },
    formButtonPrimary: {
      border: '1.5px solid #16171a', borderRadius: '0',
      boxShadow: '3px 3px 0 #16171a',
      fontSize: '11.5px', fontWeight: '700', letterSpacing: '.12em',
      textTransform: 'uppercase', padding: '11px 18px',
      '&:hover': { boxShadow: '3px 3px 0 #16171a' },
      '&:active': { boxShadow: '0 0 0 #16171a', transform: 'translate(3px,3px)' },
    },
    socialButtonsBlockButton: {
      border: '1.5px solid #16171a', borderRadius: '0', boxShadow: 'none',
      fontSize: '11.5px', fontWeight: '700', letterSpacing: '.12em', textTransform: 'uppercase',
    },
    dividerLine: { background: '#d6d8dc' },
    dividerText: {
      fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
      letterSpacing: '.14em', color: '#666a72', textTransform: 'uppercase',
    },
    formFieldErrorText: {
      fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px', color: '#e8194b',
    },
    identityPreviewEditButton: { color: '#e8194b' },
  },
};

/* ── Dark theme ────────────────────────────────────────────────────────────────
   Clerk's appearance is resolved at mount, not live, so it cannot follow a CSS variable.
   Two options, in order of preference:

   1. ACCEPT the light card in both themes (what this object does). The card sits inside
      our own panel, which is --panel; in dark theme that means a light form on a dark
      page. Visually this reads as an inset document and tested fine.

   2. If you'd rather it followed the theme: build the object from a function of the
      current theme and re-mount on change. The theme is known before Clerk.load() runs
      (initThemeEarly), so:

        const dark = document.body.dataset.theme === 'dark';
        appearance: clerkAppearance(dark)

      …with the dark branch swapping in #17181b / #f0efed / #3a3d44 / #e01046. The cost is
      that toggling the theme on the auth screen needs an unmount+remount, since Clerk
      won't restyle in place. Not worth it until someone complains — the auth screens have
      no theme toggle on them.
   ── */

export function clerkAppearance(isDark) {
  if (!isDark) return CLERK_APPEARANCE;
  const v = { ...CLERK_APPEARANCE.variables,
    colorPrimary: '#e01046', colorText: '#f0efed', colorTextSecondary: '#b4b7bd',
    colorBackground: '#17181b', colorInputBackground: '#17181b', colorInputText: '#f0efed',
    colorDanger: '#e01046' };
  const e = { ...CLERK_APPEARANCE.elements,
    formFieldInput: { ...CLERK_APPEARANCE.elements.formFieldInput, border: '1.5px solid #3a3d44' },
    formButtonPrimary: { ...CLERK_APPEARANCE.elements.formButtonPrimary,
      border: '1.5px solid #3a3d44', boxShadow: '3px 3px 0 #000' },
    socialButtonsBlockButton: { ...CLERK_APPEARANCE.elements.socialButtonsBlockButton,
      border: '1.5px solid #3a3d44' },
    dividerLine: { background: '#2b2d33' },
    formFieldLabel: { ...CLERK_APPEARANCE.elements.formFieldLabel, color: '#b4b7bd' } };
  return { variables: v, elements: e };
}
