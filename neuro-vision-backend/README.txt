NEURO VISION BACKEND - SETUP (Windows)
1. Open a terminal in this folder.
2. py -m venv .venv  &  .venv\Scripts\activate
3. pip install -r requirements.txt
4. Edit .env with your MySQL user/password (see .env.example).
5. py check_database.py      <- verifies connection + shows your real table columns
   (if tables are missing:  mysql -u USER -p neuro_vision < schema.sql)
6. py -m uvicorn main:app --reload
7. Open http://127.0.0.1:8000/docs  and  /api/health

Model files used: neuro_vision_best_model.pkl, neuro_vision_features.pkl (from Dyslexia.ipynb).
