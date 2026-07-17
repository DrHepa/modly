export type ExtensionInputPortDescriptor = {
  name:      string
  type:      'mesh' | 'image' | 'text' | 'audio'
  label?:    string
  required?: boolean
}

export type ParsedManifest = {
  id?: string
  name?: string
  displayName?: string
  version?: string
  description?: string
  author?: string | { name?: string }
  source?: string
  generator_class?: string
  type?: 'model' | 'process'
  entry?: string
  params_schema?: unknown[]
  param_defaults?: Record<string, unknown>
  io_contract?: string
  input_ports?: ExtensionInputPortDescriptor[]
  nodes?: {
    id:                  string
    name?:               string
    input?:              'mesh' | 'image' | 'text' | 'audio'
    inputs?:             ('mesh' | 'image' | 'text' | 'audio')[]
    input_labels?:       string[]
    io_contract?:        string
    input_ports?:        ExtensionInputPortDescriptor[]
    output?:             'mesh' | 'image' | 'text' | 'audio'
    params_schema?:      unknown[]
    param_defaults?:     Record<string, unknown>
    hf_repo?:            string
    download_check?:     string
    hf_skip_prefixes?:   string[]
    hf_include_prefixes?: string[]
  }[]
}

export function isTrustedSource(source: string | undefined, trustedRepos: Set<string>): boolean {
  if (!source) return false
  return trustedRepos.has(source.toLowerCase().replace(/\/$/, ''))
}

export function parseExtensionManifest(
  parsed: ParsedManifest,
  fallbackId: string,
  trustedRepos: Set<string>,
  builtin = false,
) {
  const common = {
    id:          parsed.id          ?? fallbackId,
    name:        parsed.displayName ?? parsed.name ?? fallbackId,
    version:     parsed.version,
    description: parsed.description,
    author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted:     builtin || isTrustedSource(parsed.source, trustedRepos),
    source:      parsed.source,
    builtin,
  }

  const nodes = (parsed.nodes ?? []).map((node) => ({
    id:                node.id,
    name:              node.name ?? node.id,
    input:             node.input  ?? 'image' as const,
    inputs:            node.inputs,
    inputLabels:       node.input_labels,
    io_contract:       node.io_contract ?? parsed.io_contract,
    input_ports:       node.input_ports ?? parsed.input_ports,
    output:            node.output ?? 'mesh' as const,
    paramsSchema:      node.params_schema ?? parsed.params_schema ?? [],
    paramDefaults:     { ...(parsed.param_defaults ?? {}), ...(node.param_defaults ?? {}) },
    hfRepo:            node.hf_repo,
    downloadCheck:     node.download_check,
    hfSkipPrefixes:    node.hf_skip_prefixes,
    hfIncludePrefixes: node.hf_include_prefixes,
  }))

  if (parsed.type === 'process') {
    return { ...common, type: 'process' as const, entry: parsed.entry ?? 'processor.js', nodes }
  }

  return { ...common, type: 'model' as const, nodes }
}
