export type SemanticRoleId =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'left_upper_arm'
  | 'left_lower_arm'
  | 'left_hand'
  | 'right_upper_arm'
  | 'right_lower_arm'
  | 'right_hand'
  | 'left_upper_leg'
  | 'left_lower_leg'
  | 'left_foot'
  | 'right_upper_leg'
  | 'right_lower_leg'
  | 'right_foot'
  | 'left_fingers'
  | 'right_fingers'
  | 'left_toes'
  | 'right_toes'

export const CANONICAL_SEMANTIC_ROLE_IDS: readonly SemanticRoleId[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'left_upper_arm',
  'left_lower_arm',
  'left_hand',
  'right_upper_arm',
  'right_lower_arm',
  'right_hand',
  'left_upper_leg',
  'left_lower_leg',
  'left_foot',
  'right_upper_leg',
  'right_lower_leg',
  'right_foot',
  'left_fingers',
  'right_fingers',
  'left_toes',
  'right_toes',
]

const CANONICAL_ROLE_SET = new Set<string>(CANONICAL_SEMANTIC_ROLE_IDS)

const INGESTION_ROLE_ALIASES: Record<string, SemanticRoleId> = {
  hip: 'hips',
  pelvis: 'hips',
  root: 'hips',
  spine1: 'spine',
  spine2: 'chest',
  spine3: 'chest',
  upper_chest: 'chest',
  upperchest: 'chest',
  left_arm: 'left_upper_arm',
  leftupperarm: 'left_upper_arm',
  lupperarm: 'left_upper_arm',
  left_forearm: 'left_lower_arm',
  leftforearm: 'left_lower_arm',
  left_lower_arm: 'left_lower_arm',
  leftlowerarm: 'left_lower_arm',
  left_elbow: 'left_lower_arm',
  leftelbow: 'left_lower_arm',
  right_arm: 'right_upper_arm',
  rightupperarm: 'right_upper_arm',
  rupperarm: 'right_upper_arm',
  right_forearm: 'right_lower_arm',
  rightforearm: 'right_lower_arm',
  right_lower_arm: 'right_lower_arm',
  rightlowerarm: 'right_lower_arm',
  right_elbow: 'right_lower_arm',
  rightelbow: 'right_lower_arm',
  left_leg: 'left_upper_leg',
  leftleg: 'left_upper_leg',
  left_thigh: 'left_upper_leg',
  leftthigh: 'left_upper_leg',
  left_shin: 'left_lower_leg',
  leftshin: 'left_lower_leg',
  left_lower_leg: 'left_lower_leg',
  leftlowerleg: 'left_lower_leg',
  right_leg: 'right_upper_leg',
  rightleg: 'right_upper_leg',
  right_thigh: 'right_upper_leg',
  rightthigh: 'right_upper_leg',
  right_shin: 'right_lower_leg',
  rightshin: 'right_lower_leg',
  right_lower_leg: 'right_lower_leg',
  rightlowerleg: 'right_lower_leg',
  left_toe_base: 'left_toes',
  lefttoebase: 'left_toes',
  right_toe_base: 'right_toes',
  righttoebase: 'right_toes',
}

export function normalizeSemanticRoleId(value: string | undefined): SemanticRoleId | undefined {
  if (!value) return undefined
  const snake = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (CANONICAL_ROLE_SET.has(snake)) return snake as SemanticRoleId
  const compact = snake.replace(/_/g, '')
  return INGESTION_ROLE_ALIASES[snake] ?? INGESTION_ROLE_ALIASES[compact]
}
