declare module "sql.js" {
	export interface InitSqlJsConfig {
		locateFile?: (file: string, prefix?: string) => string;
	}

	export interface Statement {
		bind(params?: Record<string, unknown>): void;
		step(): boolean;
		getAsObject(): Record<string, unknown>;
		reset(): void;
		run(params?: Record<string, unknown>): void;
		free(): void;
	}

	export class Database {
		constructor(database?: Uint8Array);
		exec(sql: string): void;
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	export interface SqlJsStatic {
		Database: typeof Database;
	}

	export type { SqlJsStatic, Database, Statement };

	const initSqlJs: (config?: InitSqlJsConfig) => Promise<SqlJsStatic>;
	export default initSqlJs;
}
