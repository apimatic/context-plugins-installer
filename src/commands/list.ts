import type { ActionResult } from '../actions/action-result.js';
import { ListAction, type ListRequest } from '../actions/list.js';
import { ListPrompts } from '../prompts/list.js';
import type { RegistryClient } from '../types/ports.js';
import type { ListReport } from '../types/reports.js';

export interface ListArgs extends ListRequest {
  json?: boolean;
  long?: boolean;
}

/** `list` says nothing until it has the catalog, so the command renders once. */
export class ListCommand {
  constructor(
    private readonly registry: RegistryClient,
    private readonly prompts = new ListPrompts(),
  ) {}

  async run(args: ListArgs): Promise<ActionResult<ListReport>> {
    const result = await new ListAction(
      this.registry,
      this.prompts.marketplaceListener,
      args.pathOpts,
    ).execute(args.brand);
    if (result.isFailed()) return result;
    if (args.json) this.prompts.json(result.report);
    else this.prompts.render(result.report, args.long);
    return result;
  }
}
