import styles from './IBeam.module.css';

/**
 * I-beam cursor shown over editable text fields (paired with the Union-Jack
 * badge in `UnionJackCursor`). A dark inner body with a fixed light outer rim, so
 * it reads as a dual layer and stays visible on dark surfaces (incl. dark-by-
 * default UI shown in light mode). Sized to fill its wrapper; centred on the
 * pointer by the caller.
 */
export default function IBeam() {
  return (
    <svg
      viewBox="0 0 14 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      {/* Outer rim drawn first (wider, behind); dark inner body on top. */}
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        className={styles.rim}
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        className={styles.core}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
