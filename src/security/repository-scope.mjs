const DEFAULT_DENIED_COMPONENTS = new Set(['nova', 'seashop', 'ai-agent']);

export function isProtectedRepositoryName(fullName, configuredNames = process.env.UDA_PROTECTED_REPOSITORIES || '') {
  if (typeof fullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return true;
  const components = fullName.toLowerCase().split('/');
  if (components.some(component => DEFAULT_DENIED_COMPONENTS.has(component))) return true;
  const denied = Array.isArray(configuredNames)
    ? configuredNames
    : String(configuredNames).split(',');
  return denied.map(name => String(name).trim().toLowerCase()).filter(Boolean).includes(fullName.toLowerCase());
}
