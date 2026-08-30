// src/types/next-auth.d.ts
import { UserRole } from '@prisma/client';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      username?: string | null;
      role: UserRole;
      trustScore: number;
      isBanned: boolean;
    };
  }

  interface User {
    role: UserRole;
    trustScore: number;
    username?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: UserRole;
    trustScore: number;
    username?: string | null;
  }
}
