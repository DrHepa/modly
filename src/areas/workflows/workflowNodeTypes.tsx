import ExtensionNode from './nodes/ExtensionNode'
import ImageNode from './nodes/ImageNode'
import TextNode from './nodes/TextNode'
import AddToSceneNode from './nodes/AddToSceneNode'
import AddToWorldsNode from './nodes/AddToWorldsNode'
import Load3DMeshNode from './nodes/Load3DMeshNode'
import LoadSceneNode from './nodes/LoadSceneNode'
import ImagePreviewNode from './nodes/ImagePreviewNode'
import PreviewImageNode from './nodes/PreviewImageNode'
import PreviewViewsNode from './nodes/PreviewViewsNode'
import PreviewVideoNode from './nodes/PreviewVideoNode'
import LandmarksNode from './nodes/LandmarksNode'
import WaitNode from './nodes/WaitNode'
import WhileNode from './nodes/WhileNode'
import ForEachNode from './nodes/ForEachNode'

import { PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIDEO_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE } from './nodes/previewNodeShared'

export const WORKFLOW_NODE_TYPES = {
  extensionNode: ExtensionNode,
  imageNode: ImageNode,
  textNode: TextNode,
  outputNode: AddToSceneNode,
  addToWorldsNode: AddToWorldsNode,
  meshNode: Load3DMeshNode,
  sceneNode: LoadSceneNode,
  imagePreviewNode: ImagePreviewNode,
  [PREVIEW_IMAGE_NODE_TYPE]: PreviewImageNode,
  [PREVIEW_VIEWS_NODE_TYPE]: PreviewViewsNode,
  [PREVIEW_VIDEO_NODE_TYPE]: PreviewVideoNode,
  landmarksNode: LandmarksNode,
  waitNode: WaitNode,
  whileNode: WhileNode,
  forEachNode: ForEachNode,
}
