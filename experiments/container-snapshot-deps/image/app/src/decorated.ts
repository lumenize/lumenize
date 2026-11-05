// A TC39 decorator, so the build runs swc the way Nebula's does for `@mesh()`.
function logged<T extends (...args: never[]) => unknown>(value: T, _ctx: ClassMethodDecoratorContext): T {
  return value;
}

export class Stamper {
  @logged
  stamp(): string {
    return "stamped";
  }
}
