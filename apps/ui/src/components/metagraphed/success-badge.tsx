/**
 * The extrinsic-success indicator, shared by every feed that renders one
 * (#6403).
 *
 * It previously existed as two byte-identical private copies (extrinsics.index
 * and call-module-extrinsics-table) plus a third inline ternary in
 * blocks.$ref, which disagreed with itself: its fail branch already used the
 * `--health-down` token while its success branch stayed on raw
 * `text-emerald-500`. The raw Tailwind palette is not theme-adaptive here --
 * `text-health-ok` / `text-health-down` are the tokens the rest of the app
 * uses for exactly this ok/down semantic (52 and 70 call sites), so a success
 * indicator rendered in emerald was the odd one out in both themes.
 *
 * `success == null` means the tier has no reading for that extrinsic (not a
 * failure), so it renders the muted em-dash placeholder rather than "fail".
 */
export function SuccessBadge({ success }: { success?: boolean | null }) {
  if (success == null) return <span className="text-ink-muted">—</span>;
  return success ? (
    <span className="text-health-ok">ok</span>
  ) : (
    <span className="text-health-down">fail</span>
  );
}
