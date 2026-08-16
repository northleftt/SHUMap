// 最小 TS 声明：开发者工具内置 TS 编译需要 wx / Page / App 等全局符号，
// 这里一律给 any，保持「只搬逻辑、不引依赖」。

declare const wx: any;
declare function Page(options: any): void;
declare function App(options: any): void;
declare function Component(options: any): void;
declare function getApp(): any;
declare function getCurrentPages(): any[];
declare function require(path: string): any;
declare const module: { exports: any };
