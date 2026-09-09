import { RepoSlug } from '../types/ids/repo-slug.js';
import type { Manifest } from '../types/installed-record.js';

/**
 * Every way the read view differs from the file: rows it dropped, and rows it
 * listed without a target name this build does not know. `scope` limits them to
 * one marketplace, whose repo is then implied and left out of the label.
 *
 * Shared by `installed`, `list` and `doctor`, because a command that renders
 * that view has to say what it left out - unmentioned, a row the user can see
 * in the file simply is not there.
 */
export function gapWarnings({ ignored, elided }: Manifest, scope?: string): string[] {
  const inScope = (repo?: string): boolean => !scope || !repo || RepoSlug.same(repo, scope);
  const label = (plugin: string | null, repo?: string): string => {
    const name = plugin ? `'${plugin}'` : 'an entry';
    const where = !scope && repo ? ` (${repo})` : '';
    return `${name}${where}`;
  };
  return [
    ...ignored
      .filter((skip) => inScope(skip.repo))
      .map(
        (skip) => `Ignoring ${label(skip.plugin, skip.repo)} in installed.json - ${skip.reason}.`,
      ),
    ...elided
      .filter((row) => inScope(row.repo))
      .map(
        (row) =>
          `Listing ${label(row.plugin, row.repo)} without unknown target(s): ${row.targets.join(', ')} - the entry on disk keeps them.`,
      ),
  ];
}
