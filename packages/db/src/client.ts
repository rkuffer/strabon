import postgres from "postgres";

// Connexion singleton — réutilisée par tous les modules db
// La connection string est lue depuis DATABASE_URL dans .env
let _sql: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Create a .env file with:\n" +
        "DATABASE_URL=postgres://user:password@localhost:5432/strabon"
      );
    }
    _sql = postgres(url, {
      max: 10,          // pool de 10 connexions
      idle_timeout: 30,
      connect_timeout: 10,
      // Convertit les colonnes snake_case en camelCase automatiquement
      transform: {
        undefined: null,
      },
    });
  }
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

// Alias pratique pour les modules qui importent directement sql
export const sql = getSql;
