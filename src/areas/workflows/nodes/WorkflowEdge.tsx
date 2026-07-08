import { getBezierPath, useReactFlow } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import { PROCESS_PORT_HANDLE_COLOR } from '../processPorts'
import { resolveWorkflowEdgeTargetColor } from './workflowEdgeColors'

export default function WorkflowEdge({
  id, source, target,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
}: EdgeProps) {
  const { getNode, getEdges } = useReactFlow()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)
  const targetHandle = getEdges().find((edge) => edge.id === id)?.targetHandle

  const sourceNode = getNode(source)
  const targetNode = getNode(target)

  const extensionOutput = allExtensions.find((e) => e.id === sourceNode?.data?.extensionId)?.output
  const sourceColor = sourceNode?.type === 'imageNode'
    ? PROCESS_PORT_HANDLE_COLOR.image
    : sourceNode?.type === 'textNode'
    ? PROCESS_PORT_HANDLE_COLOR.text
    : sourceNode?.type === 'meshNode'
    ? PROCESS_PORT_HANDLE_COLOR.mesh
    : sourceNode?.type === 'sceneNode'
    ? PROCESS_PORT_HANDLE_COLOR.scene
    : (extensionOutput ? PROCESS_PORT_HANDLE_COLOR[extensionOutput] : '#52525b')

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
          <stop offset="0%" stopColor={sourceColor} />
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
