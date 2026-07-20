import type { Workflow } from '@shared/types/electron.d'

export function resolveOpenWorkflows(workflows: Workflow[], openIds: string[]): Workflow[] {
  return openIds
    .map((id) => workflows.find((workflow) => workflow.id === id))
    .filter((workflow): workflow is Workflow => !!workflow)
}
