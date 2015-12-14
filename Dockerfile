FROM vbond/alpine-node-git:latest
MAINTAINER Christoph Wiechert <wio@psitrax.de>

RUN apk-install git && npm install -g https://github.com/vlad-x/docker-etcd-registrator

CMD ["docker-etcd-registrator"]
