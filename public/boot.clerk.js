/* TraxWax — Clerk appearance (S2 / S3)
   "TraxWax chrome, stock card": we own the frame (stateCard), Clerk owns the form.

   SPLIT OF RESPONSIBILITY (learned the hard way, 2026-08-30):
   Clerk's current build applies an appearance object's `variables` (color, font,
   radius) and `display` element rules — but NOT `border` / `box-shadow` element
   rules, which lose to its own box-shadow "ring" design system. So the FLAT look
   (killing the rings, the glossy primary button, and the .cl-cardBox drop shadow)
   lives in styles.css under ".cl-* Clerk sign-in card", where it also follows the
   theme live via tokens. This file only carries what the appearance object honors:
   the palette/type variables and the display:none for Clerk's duplicate header /
   footer (our stateCard supplies the wordmark, headline, and "Create an account").

   Reference: clerk.com/docs/customization/overview.  */

const ELEMENTS = {
  rootBox: { width: '100%' },
  card: { padding: '0', width: '100%' },
  /* Our stateCard() supplies these; Clerk's own are duplication. */
  header: { display: 'none' },
  footer: { display: 'none' },
  /* Text styling the appearance DOES honor (font/color), so it stays here. */
  formFieldLabel: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: '9.5px', fontWeight: '700',
    letterSpacing: '.16em', textTransform: 'uppercase', color: '#54585f',
  },
  dividerText: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
    letterSpacing: '.14em', color: '#666a72', textTransform: 'uppercase',
  },
  formFieldErrorText: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px', color: '#e8194b',
  },
};

export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#e8194b',          /* --accent (light) */
    colorText: '#16171a',             /* --ink */
    colorTextSecondary: '#54585f',    /* --muted */
    colorBackground: '#ffffff',       /* --panel */
    colorInputBackground: '#ffffff',
    colorInputText: '#16171a',
    colorDanger: '#e8194b',
    fontFamily: "'IBM Plex Mono', monospace",
    fontFamilyButtons: "'IBM Plex Mono', monospace",
    fontSize: '12px',
    borderRadius: '0px',
    spacingUnit: '1rem',
  },
  elements: ELEMENTS,
};

/* Dark theme. Clerk's appearance is resolved at MOUNT, not live, so the palette
   variables can't follow a CSS variable — but the flat frame in styles.css does
   (it's token-based), so only the input/text palette needs a dark swap here. The
   auth screens carry no theme toggle, so a mount-time choice is enough. */
export function clerkAppearance(isDark) {
  if (!isDark) return CLERK_APPEARANCE;
  return {
    variables: {
      ...CLERK_APPEARANCE.variables,
      colorPrimary: '#e01046', colorText: '#f0efed', colorTextSecondary: '#b4b7bd',
      colorBackground: '#17181b', colorInputBackground: '#ffffff', colorInputText: '#16171a',
      colorDanger: '#e01046',
    },
    elements: {
      ...ELEMENTS,
      formFieldLabel: { ...ELEMENTS.formFieldLabel, color: '#b4b7bd' },
    },
  };
}
