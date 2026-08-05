import { getBezierPath, useReactFlow, useEdges } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import { resolveWorkflowEdgeSourceColor, resolveWorkflowEdgeTargetColor } from './workflowEdgeColors'

export default function WorkflowEdge({
  id, source, target,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
}: EdgeProps) {
  const { getNode } = useReactFlow()
  const edges       = useEdges()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)

  const sourceNode = getNode(source)
  const targetNode = getNode(target)

  // Read targetHandle directly from edge store — reliable regardless of EdgeProps version
  const thisEdge    = edges.find((e) => e.id === id)
  const targetHandle = thisEdge?.targetHandle

  const sourceColor = resolveWorkflowEdgeSourceColor({
    sourceNodeType: sourceNode?.type,
    extensionOutput: allExtensions.find((e) => e.id === sourceNode?.data?.extensionId)?.output,
  })

  // For multi-input nodes pick the color of the specific connected handle
  const targetColor = resolveWorkflowEdgeTargetColor({
    targetNodeType: targetNode?.type,
    targetExtension: allExtensions.find((e) => e.id === targetNode?.data?.extensionId) ?? {},
    targetHandle,
  })

  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const gradientId = `wf-edge-${id}`

  return (
    <>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%"   stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>
      </defs>
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: `url(#${gradientId})`, strokeWidth: 2.5 }}
        className="react-flow__edge-path"
      />
    </>
  )
}
