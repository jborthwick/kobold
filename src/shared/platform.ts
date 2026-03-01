/** Viewport-based layout detection for Phaser (non-React) code. */

export function isMobileViewport(): boolean {
  return window.innerWidth < 768;
}

export function isTabletViewport(): boolean {
  return window.innerWidth >= 768 && window.innerWidth < 1200;
}
