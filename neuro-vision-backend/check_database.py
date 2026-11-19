"""
Inspect the REAL Neuro Vision MySQL tables and report whether the backend can use them.

    python check_database.py
"""
import json
import sys

from database import database_status, get_db_connection


def main() -> int:
    print("1) Connecting to MySQL using .env ...")
    try:
        connection = get_db_connection()
        connection.close()
        print("   OK - connection works.\n")
    except Exception as error:
        print(f"   FAILED: {error}\n   Check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME / DB_PORT in .env, "
              "and that the MySQL service is running.")
        return 1

    print("2) Reading the real table definitions ...")
    status = database_status()
    problems = 0
    for table, info in status["tables"].items():
        if not info["exists"]:
            if info["optional"]:
                print(f"   - {table}: not present (optional - raw gaze samples will not be stored; run schema.sql to add it)")
            else:
                problems += 1
                print(f"   - {table}: MISSING -> run:  mysql -u <user> -p neuro_vision < schema.sql")
            continue
        print(f"   - {table}: {len(info['columns'])} columns, primary key = {info['primary_key']}, "
              f"parent link = {info['link_to_parent']}")
        print(f"       columns: {', '.join(info['columns'])}")
        if info["unmapped_logical_fields"]:
            print(f"       not stored (no matching column): {', '.join(info['unmapped_logical_fields'])}")
    print()
    if problems:
        print(f"RESULT: {problems} required table(s) missing.")
        return 1
    print("RESULT: all four required tables exist. Inserts will adapt to the columns shown above.")
    print("If a table has a NOT NULL column without a default that is not listed above, the first save "
          "will report its name in the error message.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
