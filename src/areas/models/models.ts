export interface LocalModel {
  id:      string
  name:    string
  size_gb: number
  sharedOwner?: boolean
  ownerScopeLabel?: string
  ownerWarning?: string | null
}
