import { cubicBezier } from 'framer-motion';

/**
 * The app's standard easing.
 *
 * ⚠️ **Mirrored in CSS as `--dock-ease` (`app/styles/index.scss`) — change one, change the other.**
 * The sidebar animates on this curve while the body padding + `.header-brand` counter-translate
 * animate on the CSS one, and those are two edges that have to MEET: when the curves differed they
 * agreed only at the start and end frames, opening a measured 32px band of bare page background
 * mid-animation. See the comment on `--dock-ease` for the full reasoning.
 */
export const cubicEasingFn = cubicBezier(0.4, 0, 0.2, 1);
