export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

export interface Recipe {
  id: string;
  title: string;
  youtubeId: string;
  youtubeUrl: string;
  ingredients: string[];
  steps: string[];
  notes?: string;
  category: string;
  createdAt: string;
  userId: string;
}

export interface VideoSource {
  id: string;
  youtubeId: string;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
  userId: string;
  updatedAt: string;
}
