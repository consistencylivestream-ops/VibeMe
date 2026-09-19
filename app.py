import os
import secrets

from flask import Flask, render_template, request, redirect, url_for, session
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)

# Set SECRET_KEY in your host's environment variables so sessions survive restarts.
# If it's missing, a random key is generated (users get logged out on each restart).
app.secret_key = os.environ.get('SECRET_KEY') or secrets.token_hex(32)

# In-memory user store: username -> password hash
# NOTE: resets on every restart/redeploy. Swap for a database when you need persistence.
users = {}


@app.route('/health')
def health():
    return 'ok', 200


@app.route('/')
def home():
    return redirect(url_for('login'))


@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        if not username or not password:
            return render_template('signup.html', error='Username and password are required')
        if username in users:
            return render_template('signup.html', error='Username already exists')
        users[username] = generate_password_hash(password)
        return redirect(url_for('login'))
    return render_template('signup.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        stored = users.get(username)
        if stored and check_password_hash(stored, password):
            session['username'] = username
            return redirect(url_for('dashboard'))
        return render_template('login.html', error='Invalid credentials')
    return render_template('login.html')


@app.route('/dashboard')
def dashboard():
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'])


@app.route('/logout')
def logout():
    session.pop('username', None)
    return redirect(url_for('login'))


if __name__ == '__main__':
    # Local dev only. In production the Procfile/Dockerfile runs gunicorn instead.
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=os.environ.get('FLASK_DEBUG') == '1')
