import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';

interface CachedTileLayerOptions extends L.TileLayerOptions {
  queryClient: QueryClient;
}

/** Tile `<img>` augmented with the object URL we minted for it, so it can be revoked on unload. */
interface TileImg extends HTMLImageElement {
  _objectUrl?: string;
}

/** `L.TileLayer` that loads each tile through TanStack Query instead of letting the browser fetch `img.src` directly. Tiles are cached as Blobs keyed by their resolved URL (theme + z/x/y + retina), so repeat tiles come from the in-memory cache with no network request. */
class CachedLeafletTileLayer extends L.TileLayer {
  private queryClient: QueryClient;

  constructor(urlTemplate: string, options: CachedTileLayerOptions) {
    const { queryClient, ...leafletOptions } = options;
    super(urlTemplate, leafletOptions);
    this.queryClient = queryClient;
  }

  /** Fetch the tile blob via TanStack Query, then point the `<img>` at an object URL. Leaflet's `done` contract is honoured on load/error. */
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img') as TileImg;
    tile.setAttribute('role', 'presentation');
    tile.alt = '';

    const url = this.getTileUrl(coords);

    this.queryClient
      .fetchQuery({
        queryKey: ['map-tile', url],
        queryFn: async ({ signal }): Promise<Blob> => {
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`tile request failed: ${res.status}`);
          return res.blob();
        },
        // Tiles are immutable, so never refetch; keep blobs for the session
        // to maximise cache hits (memory vs hit-rate knob lives here).
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        retry: 1,
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        tile._objectUrl = objectUrl;
        tile.onload = () => done(undefined, tile);
        tile.onerror = () => done(new Error('tile decode failed'), tile);
        tile.src = objectUrl;
      })
      .catch((error: unknown) => {
        done(
          error instanceof Error ? error : new Error('tile fetch failed'),
          tile,
        );
      });

    return tile;
  }

  onAdd(map: L.Map): this {
    super.onAdd(map);
    this.on('tileunload', this.handleTileUnload, this);
    return this;
  }

  onRemove(map: L.Map): this {
    // super.onRemove fires `tileunload` per tile, so the handler revokes them
    // all; remove our listener only afterwards.
    super.onRemove(map);
    this.off('tileunload', this.handleTileUnload, this);
    return this;
  }

  /** Revoke the object URL once Leaflet discards a tile so the Blob isn't pinned in memory. */
  private handleTileUnload(event: L.TileEvent): void {
    const tile = event.tile as TileImg;
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

/** Drop-in replacement for react-leaflet's `<TileLayer>` that routes tiles through the TanStack Query cache. A `url` change (light/dark theme swap) re-requests tiles via Leaflet's in-place `setUrl` rather than rebuilding the layer. */
export function CachedTileLayer({ url, attribution }: CachedTileLayerProps) {
  const map = useMap();
  const queryClient = useQueryClient();
  const layerRef = useRef<CachedLeafletTileLayer | null>(null);
  const firstUrlRun = useRef(true);

  useEffect(() => {
    const layer = new CachedLeafletTileLayer(url, { attribution, queryClient });
    layerRef.current = layer;
    layer.addTo(map);
    return () => {
      layer.remove();
      layerRef.current = null;
    };
    // `url` is intentionally excluded — the effect below applies theme swaps
    // via Leaflet's setUrl, avoiding a full layer teardown/rebuild.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [map, queryClient, attribution]);

  useEffect(() => {
    if (firstUrlRun.current) {
      firstUrlRun.current = false;
      return;
    }
    layerRef.current?.setUrl(url);
  }, [url]);

  return null;
}
