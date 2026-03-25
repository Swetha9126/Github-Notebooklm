import os, time, chromadb, cohere, requests, base64
import urllib.parse
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_migrate import Migrate
from litellm import completion
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from models import db, Chat_history, Chat_session
load_dotenv()
app = Flask(__name__)
CORS(app)

password = urllib.parse.quote_plus(os.getenv("MYSQL_PASSWORD", ""))
app.config["SQLALCHEMY_DATABASE_URI"] = (
    f"mysql+pymysql://root:{password}@localhost/notebook"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
migrate = Migrate(app, db)

github_token = os.getenv("GITHUB_TOKEN")
CHROMA_PATH  = r"chroma_db"

chroma_client    = chromadb.PersistentClient(path=CHROMA_PATH)
co               = cohere.ClientV2(api_key=os.getenv("COHERE_API_KEY"))

SKIP_FILES = {".pyc", ".pyo", ".exe", ".bin", ".png", ".jpg",
              ".jpeg", ".gif", ".ico", ".db", ".lock",
              ".svg", ".woff", ".woff2", ".ttf", ".eot",
              ".map", ".min.js", ".min.css", ".mp4", ".model"}

SKIP_DIRS = {"__pycache__", ".git", "node_modules",
             ".venv", "env", "dist", "build", ".next"}

chroma_cache     = {}
collection_repos = {}


def get_embedding(text: str):
    for attempt in range(3):
        try:
            response = co.embed(
                texts=[text],
                model="embed-english-light-v3.0",
                input_type="search_query",
                embedding_types=["float"]
            )
            return response.embeddings.float[0]
        except Exception:
            time.sleep(5)

def get_embeddings_batch(texts: list):
    for attempt in range(3):
        try:
            response = co.embed(
                texts=texts,
                model="embed-english-light-v3.0",
                input_type="search_document",
                embedding_types=["float"]
            )
            return response.embeddings.float
        except Exception:
            time.sleep(10)

def get_session():
    session = requests.Session()
    retry = Retry(total=5, backoff_factor=2, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    return session

def fetch_file(item, headers, session):
    if any(item["name"].endswith(ext) for ext in SKIP_FILES):
        return None, None
    try:
        file_response = session.get(item["url"], headers=headers, timeout=30)
        if file_response.status_code == 200:
            file_data = file_response.json()
            content = base64.b64decode(file_data["content"]).decode("utf-8")
            return content, item["path"]
    except Exception:
        pass
    return None, None

def get_datas_github(repo_url: str, token: str = None):
    repo_url = repo_url.split("/blob/")[0].split("/tree/")[0]
    parts    = repo_url.rstrip("/").replace("https://github.com/", "").split("/")
    user, repo = parts[0], parts[1]

    headers = {}
    if token:
        headers["Authorization"] = f"token {token}"

    corpus, file_paths = [], []
    session            = get_session()
    all_file_items     = []

    def collect_items(path=""):
        api_url = f"https://api.github.com/repos/{user}/{repo}/contents/{path}"
        try:
            response = session.get(api_url, headers=headers, timeout=30)
            if response.status_code != 200:
                return
            for item in response.json():
                if item["type"] == "dir":
                    if item["name"] not in SKIP_DIRS:
                        collect_items(item["path"])
                elif item["type"] == "file":
                    all_file_items.append(item)
        except Exception:
            pass

    collect_items()

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_file, item, headers, session): item for item in all_file_items}
        for future in as_completed(futures):
            content, path = future.result()
            if content and path:
                corpus.append(content)
                file_paths.append(path)

    return corpus, file_paths

def chunk_text(text, file_path, chunk_size=1000, overlap=100):
    chunks, metadata = [], []
    for i in range(0, len(text), chunk_size - overlap):
        chunk = text[i:i + chunk_size]
        if chunk.strip():
            chunks.append(chunk)
            metadata.append({"file_path": file_path, "chunk_index": len(chunks) - 1, "start_pos": i})
    return chunks, metadata

def embed_and_store(corpus, file_paths, collection):
    all_chunks, all_metadata = [], []
    for content, path in zip(corpus, file_paths):
        chunks, metadata = chunk_text(content, path)
        all_chunks.extend(chunks)
        all_metadata.extend(metadata)

    existing_ids    = set(collection.get()["ids"])
    EMBED_BATCH_SIZE = 40
    embeddings      = []

    for i in range(0, len(all_chunks), EMBED_BATCH_SIZE):
        batch   = all_chunks[i:i + EMBED_BATCH_SIZE]
        success = False
        while not success:
            try:
                batch_embeddings = get_embeddings_batch(batch)
                embeddings.extend(batch_embeddings)
                success = True
            except Exception:
                time.sleep(30)
        time.sleep(10)

    BATCH_SIZE = 100
    new_ids, new_docs, new_embeddings, new_metas = [], [], [], []
    added = 0

    for chunk, meta, embedding in zip(all_chunks, all_metadata, embeddings):
        doc_id = f"{meta['file_path']}_chunk_{meta['chunk_index']}"
        if doc_id not in existing_ids:
            new_ids.append(doc_id)
            new_docs.append(chunk)
            new_embeddings.append(list(embedding))
            new_metas.append(meta)
            added += 1

        if len(new_ids) >= BATCH_SIZE:
            collection.add(ids=new_ids, documents=new_docs, embeddings=new_embeddings, metadatas=new_metas)
            new_ids, new_docs, new_embeddings, new_metas = [], [], [], []

    if new_ids:
        collection.add(ids=new_ids, documents=new_docs, embeddings=new_embeddings, metadatas=new_metas)

    return added, len(all_chunks)


@app.route("/")
def serve_index():
    return send_from_directory(os.path.join(os.path.dirname(__file__), "templates"),"index.html")

@app.route("/static/<path:filename>")
def serve_static(filename):
    return send_from_directory(os.path.join(os.path.dirname(__file__), "static"), filename)

@app.route("/load_repo", methods=["POST"])
def load_repo():
    data     = request.get_json()
    repo_url = data.get("url", "").strip()

    if not repo_url:
        return jsonify({"error": "No URL provided"})

    try:
        repo_url_clean  = repo_url.split("/blob/")[0].split("/tree/")[0]
        parts           = repo_url_clean.rstrip("/").replace("https://github.com/", "").split("/")
        repo_name       = f"{parts[0]}/{parts[1]}"
        collection_name = "github_" + repo_url_clean.replace("https://github.com/", "").replace("/", "_").replace("-", "_").strip("_")[:40]

        try:
            chroma_client.delete_collection(name=collection_name)
        except Exception:
            pass

        if collection_name in chroma_cache:
            del chroma_cache[collection_name]
        if collection_name in collection_repos:
            del collection_repos[collection_name]

        collection = chroma_client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"}
        )

        corpus, file_paths = get_datas_github(repo_url, token=github_token)
        prefixed_paths     = [f"{repo_name}/{p}" for p in file_paths]
        added, total       = embed_and_store(corpus, prefixed_paths, collection)

        cache = collection.get()
        chroma_cache[collection_name]     = cache
        collection_repos[collection_name] = [repo_name]

        # ✅ Create new chat session in MySQL
        new_session = Chat_session(
            collection_name=collection_name,
            repos=repo_name,
            repo_url=repo_url
            # ✅ removed created_at and updated_at — not in your model
        )
        db.session.add(new_session)
        db.session.commit()
        session_id = new_session.id

        return jsonify({
            "repo_name":       repo_name,
            "files":           prefixed_paths,
            "chunks":          total,
            "collection_name": collection_name,
            "all_repos":       [repo_name],
            "session_id":      session_id
        })

    except Exception as e:
        return jsonify({"error": str(e)})


@app.route("/add_repo", methods=["POST"])
def add_repo():
    data            = request.get_json()
    repo_url        = data.get("url", "").strip()
    collection_name = data.get("collection_name", "").strip()
    session_id      = data.get("session_id")

    if not repo_url:
        return jsonify({"error": "No URL provided"})
    if not collection_name:
        return jsonify({"error": "No collection name provided"})

    try:
        repo_url_clean = repo_url.split("/blob/")[0].split("/tree/")[0]
        parts          = repo_url_clean.rstrip("/").replace("https://github.com/", "").split("/")
        repo_name      = f"{parts[0]}/{parts[1]}"

        collection = chroma_client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"}
        )

        corpus, file_paths = get_datas_github(repo_url, token=github_token)
        prefixed_paths     = [f"{repo_name}/{p}" for p in file_paths]
        added, total       = embed_and_store(corpus, prefixed_paths, collection)

        cache = collection.get()
        chroma_cache[collection_name] = cache

        if collection_name not in collection_repos:
            collection_repos[collection_name] = []
        if repo_name not in collection_repos[collection_name]:
            collection_repos[collection_name].append(repo_name)

        all_repos = collection_repos[collection_name]

        # ✅ Update session repos in MySQL
        if session_id:
            session_obj = Chat_session.query.get(session_id)
            if session_obj:
                session_obj.repos      = ",".join(all_repos)
                # session_obj.updated_at = datetime.now()
                db.session.commit()

        return jsonify({
            "repo_name":       repo_name,
            "new_files":       prefixed_paths,
            "new_chunks":      total,
            "total_chunks":    len(cache["ids"]),
            "all_repos":       all_repos,
            "collection_name": collection_name
        })

    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/ask", methods=["POST"])
def ask():
    data            = request.get_json()
    query           = data.get("query", "").strip()
    collection_name = data.get("collection_name", "")
    session_id      = data.get("session_id")

    if not query or not collection_name:
        return jsonify({"error": "Missing query or collection_name"})

    try:
        collection = chroma_client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"}
        )

        if collection_name not in chroma_cache:
            chroma_cache[collection_name] = collection.get()

        cache = chroma_cache[collection_name]

        query_embedding = get_embedding(query)
        results         = collection.query(query_embeddings=[list(query_embedding)], n_results=10)

        matched_docs  = results["documents"][0]
        matched_metas = results["metadatas"][0]

        unique_files  = list(set(meta["file_path"] for meta in cache["metadatas"]))
        mentioned_file = None
        for file_path in unique_files:
            filename = file_path.split("/")[-1]
            if filename.lower() in query.lower() or file_path.lower() in query.lower():
                mentioned_file = file_path
                break

        if mentioned_file:
            file_chunks = []
            for doc, meta in zip(cache["documents"], cache["metadatas"]):
                if mentioned_file == meta["file_path"]:
                    file_chunks.append((meta["chunk_index"], doc))
            file_chunks.sort(key=lambda x: x[0])
            full_content = "".join([chunk for _, chunk in file_chunks])
            context = f"--- Full content of {mentioned_file} ---\n{full_content}"
        else:
            context = ""
            for doc, meta in zip(matched_docs, matched_metas):
                context += f"\n\n--- File: {meta['file_path']} ---\n{doc[:500]}"

        for attempt in range(3):
            try:
                response = completion(
                    model="gemini/gemini-3-flash-preview",
                    api_key=os.getenv("GEMINI_API_KEY"),
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a GitHub repository assistant. Answer questions about the repository based on the provided file contents. Be concise and accurate. When showing code, wrap it in proper code blocks."
                        },
                        {
                            "role": "user",
                            "content": f"Query: {query}\n\nRepository context:\n{context[:6000]}"
                        }
                    ],
                    max_tokens=16000
                )
                answer = response.choices[0].message.content

                if session_id:
                    db.session.add(Chat_history(
                        session_id=session_id,
                        role="user",
                        message=query
                    ))
                    db.session.add(Chat_history(
                        session_id=session_id,
                        role="ai",
                        message=answer
                    ))
                    db.session.commit()

                return jsonify({"answer": answer, "mentioned_file": mentioned_file})

            except Exception as e:
                if "429" in str(e):
                    time.sleep(30)
                else:
                    raise e

        return jsonify({"error": "Rate limit exceeded. Please wait 30 seconds."})

    except Exception as e:
        return jsonify({"error": str(e)})


@app.route("/history", methods=["GET"])
def get_history():
    try:
        sessions = Chat_session.query.order_by(Chat_session.id.desc()).all()
        result = []
        for s in sessions:
            # Count messages for this session
            msg_count = Chat_history.query.filter_by(session_id=s.id).count()
            result.append({
                "id":              s.id,
                "title":           s.repos.split(",")[0] if s.repos else "Untitled",
                "repos":           s.repos.split(",") if s.repos else [],
                "collection_name": s.collection_name,
                "message_count":   msg_count,
                "repo_url":        s.repo_url or '#',
                "updated_at":      None
            })
        return jsonify({"sessions": result})
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/history/<int:session_id>", methods=["GET"])
def get_session_messages(session_id):
    try:
        session_obj = Chat_session.query.get(session_id)
        if not session_obj:
            return jsonify({"error": "Session not found"})

        messages = Chat_history.query.filter_by(
            session_id=session_id
        ).order_by(Chat_history.id).all()

        return jsonify({
            "session": {
                "id":              session_obj.id,
                "title":           session_obj.repos.split(",")[0] if session_obj.repos else "Untitled",
                "repos":           session_obj.repos.split(",") if session_obj.repos else [],
                "collection_name": session_obj.collection_name,
                "repo_url":        session_obj.repo_url or "#"
            },
            # ✅ map message → content so frontend works
            "messages": [
                {
                    "id":         m.id,
                    "session_id": m.session_id,
                    "role":       m.role,
                    "content":    m.message   # ← key fix
                }
                for m in messages
            ]
        })
    except Exception as e:
        return jsonify({"error": str(e)})
    
@app.route("/history/<int:session_id>", methods=["DELETE"])
def delete_session(session_id):
    try:
        # ✅ Delete messages first (no cascade since no relationship)
        Chat_history.query.filter_by(session_id=session_id).delete()
        Chat_session.query.filter_by(id=session_id).delete()
        db.session.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)})
    

@app.route("/history/clear", methods=["DELETE"])
def clear_all_history():
    try:
        Chat_history.query.delete()
        Chat_session.query.delete()
        db.session.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)})

with app.app_context():
    db.create_all()
    print("✅ MySQL tables created successfully")

if __name__ == "__main__":
    app.run(debug=True, port=5000, use_reloader=False)
