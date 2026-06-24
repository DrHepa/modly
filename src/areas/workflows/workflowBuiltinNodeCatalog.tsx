import React from 'react'

import {
  PREVIEW_IMAGE_NODE_TYPE,
  PREVIEW_IMAGE_TITLE,
  PREVIEW_VIEWS_NODE_TYPE,
  PREVIEW_VIEWS_TITLE,
} from './nodes/previewNodeShared'

export const WORKFLOW_BUILTIN_PANEL_NODES = [
  { type: 'imageNode', label: 'Image', color: '#38bdf8', icon: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></> },
  { type: 'textNode', label: 'Text', color: '#fbbf24', icon: <><path d="M17 6.1H3M21 12.1H3M15.1 18H3"/></> },
  { type: 'meshNode', label: 'Load 3D Mesh', color: '#a78bfa', icon: <><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></> },
  { type: 'sceneNode', label: 'Load Scene', color: '#34d399', icon: <><path d="M4 7h16"/><path d="M7 4h10v16H7z"/><path d="M10 11h4"/><path d="M10 15h4"/></> },
  { type: 'outputNode', label: 'Add to Scene', color: '#a78bfa', icon: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></> },
  { type: 'addToWorldsNode', label: 'Add to Worlds', color: '#a78bfa', icon: <><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></> },
  { type: PREVIEW_IMAGE_NODE_TYPE, label: PREVIEW_IMAGE_TITLE, color: '#38bdf8', icon: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></> },
  { type: PREVIEW_VIEWS_NODE_TYPE, label: PREVIEW_VIEWS_TITLE, color: '#38bdf8', icon: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></> },
  { type: 'landmarksNode', label: 'Landmarks', color: '#22c55e', icon: <><path d="M12 3v18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="3"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="8" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></> },
  { type: 'waitNode', label: 'Wait', color: '#71717a', icon: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></> },
] as const

export const WORKFLOW_BUILTIN_PALETTE_NODES = [
  { type: 'imageNode', label: 'Image', color: '#38bdf8', description: 'Image input' },
  { type: 'textNode', label: 'Text', color: '#fbbf24', description: 'Text input' },
  { type: 'meshNode', label: 'Load 3D Mesh', color: '#a78bfa', description: 'Load a 3D mesh file or use current model' },
  { type: 'sceneNode', label: 'Load Scene', color: '#34d399', description: 'Load an existing scene manifest or scene directory' },
  { type: 'outputNode', label: 'Add to Scene', color: '#a78bfa', description: 'Output node — adds the mesh to the 3D scene' },
  { type: 'addToWorldsNode', label: 'Add to Worlds', color: '#a78bfa', description: 'Output node — adds the mesh to Worlds' },
  { type: PREVIEW_IMAGE_NODE_TYPE, label: PREVIEW_IMAGE_TITLE, color: '#38bdf8', description: 'Displays a single upstream image output' },
  { type: PREVIEW_VIEWS_NODE_TYPE, label: PREVIEW_VIEWS_TITLE, color: '#38bdf8', description: 'Displays multi-view image strips in a 2×3 grid' },
  { type: 'landmarksNode', label: 'Landmarks', color: '#22c55e', description: 'Pick the 5 required landmarks on a mesh checkpoint' },
  { type: 'waitNode', label: 'Wait', color: '#71717a', description: 'Pauses the workflow until you click Continue' },
] as const

export const WORKFLOW_BUILTIN_NODE_TYPES = WORKFLOW_BUILTIN_PALETTE_NODES.map((node) => node.type)

export function createBuiltinWorkflowNode(type: string, position: { x: number; y: number }, extensionId?: string) {
  return {
    id: crypto.randomUUID(),
    type,
    position,
    data: { extensionId, enabled: true, params: {} },
  }
}
