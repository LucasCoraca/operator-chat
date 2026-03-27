import mysql from 'mysql2/promise';
declare const pool: mysql.Pool;
export declare function testConnection(): Promise<boolean>;
export declare function initializeDatabase(): Promise<void>;
export declare function query<T>(sql: string, params?: any[]): Promise<T[]>;
export declare function execute(sql: string, params?: any[]): Promise<any>;
export declare function queryOne<T>(sql: string, params?: any[]): Promise<T | null>;
export declare function transaction<T>(callback: (connection: mysql.PoolConnection) => Promise<T>): Promise<T>;
export default pool;
//# sourceMappingURL=db.d.ts.map