# Any host that runs containers: Fly, Cloud Run, Render, a VPS. Node 24 for
# node:sqlite, no dependencies to install, so the image is small and the build is
# instant.
FROM node:24-alpine
WORKDIR /app
COPY outputs/demo ./outputs/demo
# The database lives on a mounted volume in a real deployment. Without a volume it
# is written here and lost when the container is replaced.
ENV DB_FILE=/data/goldenhue.db
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "outputs/demo/server.js"]
