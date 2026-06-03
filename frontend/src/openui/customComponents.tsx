import { useContext, useState, type CSSProperties } from 'react';
import { z } from 'zod/v4';
import { createLibrary, defineComponent } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui';
import { UIStreamingContext } from './streamingContext';

/**
 * Custom OpenUI components registered on top of the built-in library.
 *
 * `extendedLibrary` = every built-in OpenUI component + the ones defined here.
 * UIRenderer renders against this library, and the system prompt is generated
 * from an equivalent library in frontend/scripts/gen-openui-prompt.mjs.
 *
 * IMPORTANT: the model only learns about a component from the generated prompt.
 * If you change Video's name / schema / description below, mirror it in
 * gen-openui-prompt.mjs and regenerate (node scripts/gen-openui-prompt.mjs).
 */

/** Extract a YouTube video id from the common URL shapes, or null if not YouTube. */
function youtubeId(src: string): string | null {
  try {
    const url = new URL(src.trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return url.pathname.slice(1) || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const m = url.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

const FRAME_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  borderRadius: 'var(--openui-radius-s, 8px)',
  overflow: 'hidden',
  background: '#000',
};

const PLAY_BADGE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 64,
  height: 64,
  borderRadius: '50%',
  background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  fontSize: 24,
  paddingLeft: 4,
};

/**
 * YouTube player with a click-to-play facade.
 *
 * CRITICAL: the iframe is NEVER mounted while the reply is streaming, and not
 * until the user clicks play. The OpenUI Renderer re-parses on every streamed
 * token, so an always-on iframe would repeatedly mount/destroy YouTube's media
 * pipeline many times per second — which crashes the browser on Wayland/NVIDIA
 * WebRender. The facade (a thumbnail + play button) is cheap to re-render; the
 * heavy player loads only on demand, once.
 */
function YouTubeEmbed({ id, title }: { id: string; title?: string }) {
  const isStreaming = useContext(UIStreamingContext);
  const [activated, setActivated] = useState(false);

  const caption = title ? (
    <figcaption className="openui-text-neutral-secondary" style={{ marginTop: 6, fontSize: '0.85em' }}>
      {title}
    </figcaption>
  ) : null;

  if (activated && !isStreaming) {
    return (
      <figure style={{ margin: '0.5rem auto', width: '100%', maxWidth: 720 }}>
        <div style={FRAME_STYLE}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`}
            title={title || 'YouTube video player'}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            allowFullScreen
          />
        </div>
        {caption}
      </figure>
    );
  }

  return (
    <figure style={{ margin: '0.5rem auto', width: '100%', maxWidth: 720 }}>
      <button
        type="button"
        onClick={() => { if (!isStreaming) setActivated(true); }}
        aria-label={title ? `Play video: ${title}` : 'Play video'}
        style={{ ...FRAME_STYLE, display: 'block', padding: 0, border: 0, cursor: isStreaming ? 'default' : 'pointer' }}
      >
        {/* Thumbnail only once streaming has settled — avoid any network churn mid-stream. */}
        {!isStreaming ? (
          <img
            src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
            alt={title || ''}
            loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : null}
        <span style={PLAY_BADGE}>▶</span>
      </button>
      {caption}
    </figure>
  );
}

/**
 * Video — embeds a YouTube player. The model emits e.g.
 *   vid = Video("https://youtube.com/watch?v=…", "Demo")
 * YouTube URLs render as a click-to-play facade (see YouTubeEmbed); any other
 * host renders a safe "Open video ↗" link instead of embedding arbitrary
 * third-party content (the URL may originate from a prompt-injected search
 * result, so we never blindly iframe it).
 */
const VideoComponent = defineComponent({
  name: 'Video',
  props: z.object({
    src: z.string(),
    title: z.string().optional(),
  }),
  description:
    'Embed a video. src must be a YouTube URL (youtube.com/watch?v=…, youtu.be/…, /embed/…, or /shorts/…) to render an inline player; any other URL renders an "Open video" link button. title is optional caption/aria text. Only use real video URLs you actually have (e.g. from search results) — never invent one.',
  component: ({ props }) => {
    const id = youtubeId(props.src);
    if (id) {
      return <YouTubeEmbed id={id} title={props.title} />;
    }
    // Non-YouTube host: offer a safe link rather than embedding unknown content.
    return (
      <a
        href={props.src}
        target="_blank"
        rel="noopener noreferrer"
        className="openui-text-neutral-primary"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderRadius: 'var(--openui-radius-s, 8px)',
          border: '1px solid var(--openui-border-default, #3a3a3a)',
          textDecoration: 'none',
        }}
      >
        ▶ {props.title || 'Open video'} ↗
      </a>
    );
  },
});

// Add Video to the "Content" group so it shows up in the generated prompt's
// grouped component listing alongside Image/ImageBlock.
const componentGroups = (openuiLibrary.componentGroups ?? []).map((g) =>
  g.name === 'Content' ? { ...g, components: [...g.components, 'Video'] } : g,
);

/** Built-in OpenUI components + our custom ones. Pass this to <Renderer />. */
export const extendedLibrary = createLibrary({
  root: openuiLibrary.root,
  componentGroups,
  components: [...Object.values(openuiLibrary.components), VideoComponent],
});
