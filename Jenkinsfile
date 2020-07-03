pipeline {
    agent any
    tools {
        nodejs 'Node 12'
    }
    stages {
        stage('build') {
            steps {
                sh 'rm -r out || true'
                sh 'npm install'
                sh 'npx electron-forge package --platform win32'
                sh 'npx electron-forge package --platform linux'
                sh 'mv out/pakkit-win32-x64 out/pakkit-windows-x64'
                sh 'zip -r out/pakkit-windows-x64.zip out/pakkit-windows-x64/'
                sh 'zip -r out/pakkit-linux-x64.zip out/pakkit-linux-x64/'
                archiveArtifacts artifacts: '**/out/*.zip', fingerprint: true
                sh 'rm -r out'
            }
        }
    }
}
