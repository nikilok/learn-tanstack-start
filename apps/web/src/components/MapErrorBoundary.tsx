import { Component, type ReactNode } from 'react';

/**
 * Collapses a failed map (geocode RPC rejection, Leaflet chunk load failure)
 * instead of letting the error propagate through Suspense to the root crash
 * screen — maps are decoration, never worth the page.
 */
export class MapErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[Map] render failed:', error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
