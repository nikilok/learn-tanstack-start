import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

interface CachedTileLayerOptions extends L.TileLayerOptions {
  queryClient: QueryClient;
}

/** Tile `<img>` augmented with the object URL we minted for it, plus a flag set when Leaflet discards the tile so a late-resolving fetch doesn't mint a URL nothing will revoke. */
interface TileImg extends HTMLImageElement {
  _objectUrl?: string;
  _discarded?: boolean;
}

// Tiles are immutable so they never go stale, but blobs are held in the shared
// app QueryClient — bound retention to a session-ish window so heavy panning
// can't grow memory without limit. Tune up for more cache hits, down for less RAM.
const TILE_GC_TIME = 30 * 60 * 1000;

/** `L.TileLayer` that loads each tile through TanStack Query instead of letting the browser fetch `img.src` directly. Tiles are cached as Blobs keyed by their resolved URL (theme + z/x/y + retina), so repeat tiles come from the in-memory cache with no network request. Object URLs are freed via Leaflet's `tileunload`/`tileabort` events, and a discard flag stops a late-resolving fetch from leaking one. */
class CachedLeafletTileLayer extends L.TileLayer {
  private queryClient: QueryClient;

  constructor(urlTemplate: string, options: CachedTileLayerOptions) {
    const { queryClient, ...leafletOptions } = options;
    super(urlTemplate, leafletOptions);
    this.queryClient = queryClient;
  }

  /** Fetch the tile blob via TanStack Query, then point the `<img>` at an object URL. Lifecycle guards ensure a tile removed mid-flight neither leaks its URL nor revives at a stale zoom. */
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img') as TileImg;
    tile.setAttribute('role', 'presentation');
    tile.alt = '';

    const url = this.getTileUrl(coords);
    const tileZoom = coords.z;

    this.queryClient
      .fetchQuery({
        queryKey: ['map-tile', url],
        queryFn: async (): Promise<Blob> => {
          // `redirect: 'error'` rejects the route's 302 -> /blocked-tile.png so an
          // auth-failure placeholder is never cached under a real tile's key.
          const res = await fetch(url, { redirect: 'error' });
          if (!res.ok) throw new Error(`tile request failed: ${res.status}`);
          const type = res.headers.get('content-type');
          if (!type?.startsWith('image/')) {
            throw new Error(`tile not an image: ${type ?? 'unknown'}`);
          }
          return res.blob();
        },
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: TILE_GC_TIME,
        retry: false,
      })
      .then((blob) => {
        // Tile was discarded mid-fetch (Leaflet churns tiles, and StrictMode
        // remounts the layer) or the map zoomed away — don't mint a URL nothing
        // will revoke, or revive a wrong-scale tile. The blob stays cached for the
        // re-created tile to reuse. We deliberately let the fetch run to completion
        // rather than abort it: aborting on Leaflet's tile churn cancelled the
        // shared (deduped) in-flight request out from under live tiles.
        const currentZoom = (this as unknown as { _tileZoom?: number })
          ._tileZoom;
        if (
          tile._discarded ||
          (currentZoom !== undefined && tileZoom !== currentZoom)
        ) {
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        tile._objectUrl = objectUrl;
        tile.onload = () => {
          if (tile._discarded) return;
          done(undefined, tile);
        };
        tile.onerror = () => {
          // A discard mid-load revokes the object URL, which itself trips onerror —
          // that's not a bad blob, so don't evict a healthy cache entry.
          if (tile._discarded) return;
          // Genuine undecodable body (e.g. a truncated 200): free the dead URL and
          // evict so the tile can recover on a later view instead of being pinned
          // as a permanent failure.
          URL.revokeObjectURL(objectUrl);
          tile._objectUrl = undefined;
          this.queryClient.removeQueries({ queryKey: ['map-tile', url] });
          done(new Error('tile decode failed'), tile);
        };
        tile.src = objectUrl;
      })
      .catch((error: unknown) => {
        if (tile._discarded) return;
        done(
          error instanceof Error ? error : new Error('tile fetch failed'),
          tile,
        );
      });

    return tile;
  }

  onAdd(map: L.Map): this {
    super.onAdd(map);
    this.on('tileunload tileabort', this.handleTileDiscard, this);
    return this;
  }

  onRemove(map: L.Map): this {
    // super.onRemove fires `tileunload` per remaining tile, so the handler aborts
    // and revokes them all; detach our listener only afterwards.
    super.onRemove(map);
    this.off('tileunload tileabort', this.handleTileDiscard, this);
    return this;
  }

  /** Mark a discarded tile so its late-resolving fetch won't mint an orphan URL, and free its object URL if one was already minted. */
  private handleTileDiscard(event: L.LeafletEvent): void {
    const tile = (event as L.TileEvent).tile as TileImg;
    tile._discarded = true;
    if (tile._objectUrl) {
      URL.revokeObjectURL(tile._objectUrl);
      tile._objectUrl = undefined;
    }
  }
}

interface CachedTileLayerProps {
  url: string;
  attribution?: string;
}

/** Drop-in replacement for react-leaflet's `<TileLayer>` that routes tiles through the TanStack Query cache. A `url` change (light/dark theme swap) rebuilds the layer so it re-adds through Leaflet's `_setView` path. */
export function CachedTileLayer({ url, attribution }: CachedTileLayerProps) {
  const map = useMap();
  const queryClient = useQueryClient();

  useEffect(() => {
    const layer = new CachedLeafletTileLayer(url, { attribution, queryClient });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
    // Rebuild on a `url` (theme) change rather than calling `setUrl`: Leaflet's
    // in-place setUrl → GridLayer.redraw sets `_tileZoom` via `_clampZoom`, which
    // does NOT round, so on a fractional-zoom map (zoomSnap < 1, e.g. the
    // address-change journey map) tiles get a fractional `coords.z`, the tile URL
    // carries a non-integer z the proxy rejects, and the map blanks until the next
    // pan/zoom. Re-adding routes through `_setView`, which rounds `_tileZoom`
    // correctly. Tiles are keyed by url in the query cache, so this refetches
    // nothing already seen.
  }, [map, queryClient, url, attribution]);

  return null;
}
