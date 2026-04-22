import ExtensionNode from './nodes/ExtensionNode'
import ImageNode from './nodes/ImageNode'
import TextNode from './nodes/TextNode'
import AddToSceneNode from './nodes/AddToSceneNode'
import Load3DMeshNode from './nodes/Load3DMeshNode'
import PreviewImageNode from './nodes/PreviewImageNode'
import PreviewViewsNode from './nodes/PreviewViewsNode'
import WaitNode from './nodes/WaitNode'

import { PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE } from './nodes/previewNodeShared'

export const WORKFLOW_NODE_TYPES = {
  extensionNode: ExtensionNode,
  imageNode: ImageNode,
  textNode: TextNode,
  outputNode: AddToSceneNode,
  meshNode: Load3DMeshNode,
  [PREVIEW_IMAGE_NODE_TYPE]: PreviewImageNode,
  [PREVIEW_VIEWS_NODE_TYPE]: PreviewViewsNode,
  waitNode: WaitNode,
}
