from flask_sqlalchemy import SQLAlchemy

db =  SQLAlchemy()
class Chat_history(db.Model):
    __tablename__ = "CHAT_HISTORY"
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer)
    role = db.Column(db.String(20))  
    message = db.Column(db.Text)

class Chat_session(db.Model):
    __tablename__ = "CHAT_SESSION"
    id = db.Column(db.Integer, primary_key=True)
    collection_name = db.Column(db.String(200), nullable=False)
    repos = db.Column(db.String(500), nullable=False)
    repo_url = db.Column(db.String(500), nullable=False)
