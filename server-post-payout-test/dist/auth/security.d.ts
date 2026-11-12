export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, storedHash: string): Promise<boolean>;
export declare function createSessionToken(): string;
export declare function hashSessionToken(token: string): string;
//# sourceMappingURL=security.d.ts.map