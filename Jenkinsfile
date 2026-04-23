pipeline {
    agent {
        label 'node'
    }

    environment {
        IMAGE_REPOSITORY = "${getAccountKeyByBranch(env.BRANCH_NAME)}.dkr.ecr.ap-south-1.amazonaws.com"
        IMAGE_NAME = "qa-use"
        IMAGE_TAG = """${sh(
                    script: 'git rev-parse --short HEAD',
                    returnStdout: true
                ).trim()}"""
        HELM_NAME = "qa-use"
        NAMESPACE = "${getNamespaceByBranch(env.BRANCH_NAME)}"
    }

    post {
        success {
            slackSend(channel: "C05U7CLTKMZ", tokenCredentialId: "slack-token", color: "good", notifyCommitters: true, teamDomain: "xenohq", message: "Build Success - ${env.JOB_NAME} ${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)")
        }
        failure {
            slackSend(channel: "C05U7CLTKMZ", tokenCredentialId: "slack-token", color: "#e04343", notifyCommitters: true, teamDomain: "xenohq", message: "Build Failed - ${env.JOB_NAME} ${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)")
        }
    }

    options {
        buildDiscarder(logRotator(artifactDaysToKeepStr: '', artifactNumToKeepStr: '', daysToKeepStr: '', numToKeepStr: '30'))
        disableConcurrentBuilds()
    }

    stages {
        stage('SLACK NOTIFY') {
            when {
                anyOf {
                    branch 'prod'
                    branch 'dev'
                }
            }
            steps {
                slackSend(channel: "C05U7CLTKMZ", tokenCredentialId: "slack-token", color: "good", notifyCommitters: true, teamDomain: "xenohq", message: "Build Started - ${env.JOB_NAME} ${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)")
            }
        }

        stage("AWS Login") {
            steps {
                script {
                    sh 'aws ecr get-login-password --region ap-south-1 | docker login -u AWS --password-stdin ${IMAGE_REPOSITORY}'
                }
            }
        }

        stage("Build Stage") {
            steps {
                script {
                    sh """
                        DOCKER_BUILDKIT=1 docker build \
                            -t ${IMAGE_NAME}:${IMAGE_TAG} .
                    """
                    sh "docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${IMAGE_REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}"
                }
            }
        }

        stage("Push Image to ECR") {
            steps {
                script {
                    sh "docker push ${IMAGE_REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}"
                }
            }
        }

        stage('Update Values and Push to K8s Repo') {
            when {
                anyOf {
                    branch 'prod'
                    branch 'dev'
                }
            }
            steps {
                script {
                    def GIT_TAG = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    def DEPLOYMENT_BRANCH = (env.BRANCH_NAME == 'prod') ? 'prod' : 'dev'

                    withCredentials([usernamePassword(
                        credentialsId: 'f828ed55-33f6-4270-a39b-d773fe0d2d9c',
                        usernameVariable: 'GIT_USERNAME',
                        passwordVariable: 'GIT_PASSWORD'
                    )]) {
                        sh """
                            echo "Cloning xeno-k8s-deployments repository..."

                            rm -rf xeno-k8s-deployments

                            git clone https://\${GIT_USERNAME}:\${GIT_PASSWORD}@github.com/xenolab007/xeno-k8s-deployments.git
                            cd xeno-k8s-deployments

                            git checkout ${DEPLOYMENT_BRANCH}
                            git pull origin ${DEPLOYMENT_BRANCH}
                        """

                        sh """
                            echo "Updating values YAML files..."

                            cd xeno-k8s-deployments/qa-use/values

                            VALUES_FILE="${DEPLOYMENT_BRANCH}.yaml"

                            if [ -f "\$VALUES_FILE" ]; then
                                echo "Updating values/\$VALUES_FILE..."

                                sed -i "s|repository:.*|repository: '${IMAGE_REPOSITORY}/${IMAGE_NAME}' |g" "\$VALUES_FILE"
                                sed -i "s|tag:.*|tag: '${GIT_TAG}'|g" "\$VALUES_FILE"

                                echo "Updated values/\$VALUES_FILE"
                                cat "\$VALUES_FILE" | grep -A 2 "image:"
                            else
                                echo "Error: \$VALUES_FILE not found!"
                                exit 1
                            fi
                        """

                        sh """
                            cd xeno-k8s-deployments

                            git config user.name "Jenkins CI"
                            git config user.email "jenkins@xeno.com"

                            if git diff --quiet && git diff --cached --quiet; then
                                echo "No changes to commit"
                            else
                                echo "Committing and pushing changes..."

                                git add qa-use/values/${DEPLOYMENT_BRANCH}.yaml

                                git commit -m "Update qa-use image to ${GIT_TAG} for ${env.BRANCH_NAME}

- Repository: ${IMAGE_REPOSITORY}/${IMAGE_NAME}
- Tag: ${GIT_TAG}
- Branch: ${env.BRANCH_NAME}
- Build: ${env.BUILD_NUMBER}
- Triggered by: ${env.BUILD_URL}"

                                git push https://\${GIT_USERNAME}:\${GIT_PASSWORD}@github.com/xenolab007/xeno-k8s-deployments.git ${DEPLOYMENT_BRANCH}

                                echo "Successfully pushed changes to xeno-k8s-deployments/${DEPLOYMENT_BRANCH}"
                            fi
                        """
                    }
                }
            }
        }
    }
}

def getAccountKeyByBranch(branch) {
    if (branch == 'prod') {
        return '025778817848'
    } else {
        return '315221066430'
    }
}

def getNamespaceByBranch(branch) {
    return 'qa-use'
}

def getHelmValuesByBranch(branch) {
    if (branch == 'prod') {
        return 'values/prod.yaml'
    } else {
        return 'values/dev.yaml'
    }
}
