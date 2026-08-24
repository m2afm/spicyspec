/**
 * The rotation's workflow id — one derivation, three callers.
 *
 * `run`, `halt` and the supervisor must name the SAME workflow. A supervisor that derived
 * the id even slightly differently would describe a workflow that does not exist, conclude
 * the rotation was dead, and start a SECOND one alongside the live rotation — two rotations
 * opening work off one queue is the worst outcome self-healing could produce.
 */
export function rotationWorkflowId(projectName: string): string {
  return `queue-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}
