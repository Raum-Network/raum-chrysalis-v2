export async function optionalImport<T = any>(moduleName: string): Promise<T | null> {
  try {
    const importer = new Function("moduleName", "return import(moduleName)") as (name: string) => Promise<T>;
    return await importer(moduleName);
  } catch {
    return null;
  }
}
