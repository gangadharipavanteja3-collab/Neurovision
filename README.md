# Neurovision
### 1. Project Title

**“Our project is Dyslexia Detection Using Eye-Tracking and Machine Learning.”**

The main aim of our project is to identify whether a person is at risk of dyslexia by analyzing eye-movement and reading-related features.

### 2. Problem Statement

**“The problem we are addressing is that traditional dyslexia identification can require considerable time and specialized assessment.”**

Our project uses eye-related reading patterns and machine learning to provide an automated screening approach.

### 3. Proposed Solution

Our system uses a **webcam-based eye-tracking approach** to collect eye-movement information while the user reads a passage.

We extract features such as:

* Fixation duration
* Saccade-related features
* Number of fixations
* Reading-related behavior

These features are given to a machine-learning model to predict the dyslexia risk.

### 4. Machine Learning Models

We use machine-learning algorithms such as:

* **Random Forest (RF)**
* **Support Vector Machine (SVM)**

We compare their performance using metrics such as **accuracy, precision, recall, and F1-score**, and select the better-performing model.

### 5. Technologies Used

The main technologies used in our project are:

* **Python** – main programming language
* **OpenCV** – image and video processing
* **MediaPipe** – face and eye landmark detection
* **Random Forest** – machine-learning classification
* **SVM** – machine-learning classification
* **FastAPI** – backend/API
* **Dataset** – training and evaluation data

### 6. Project Workflow

The basic workflow is:

**User → Webcam → Face/Eye Detection → Feature Extraction → Machine Learning Model → Dyslexia Risk Prediction → Report**

First, the user enters the required information and reads a passage.

The webcam captures the user's eye movements. OpenCV and MediaPipe are used to detect the face and eye landmarks.

From these eye movements, we calculate useful features.

The extracted features are passed to the trained machine-learning model.

Finally, the system produces the predicted dyslexia risk and generates a report.

### 7. Dataset

The dataset contains eye-tracking and reading-related features used for training and testing the machine-learning models.

The data is processed before being given to the models so that the required features can be used for prediction.

### 8. Installation

The README also explains how to install the required Python libraries.

We use a **requirements.txt** file so that all required dependencies can be installed using:

`pip install -r requirements.txt`

### 9. How to Run

After installing the dependencies, we run the backend/application and start the system.

The user can then provide the required input, complete the reading task, and receive the prediction/report.

### 10. Purpose of the Project

**“Our project is intended as a screening/support tool, not as a medical diagnosis. The purpose is to provide an automated indication of dyslexia risk based on eye-movement patterns.”**
