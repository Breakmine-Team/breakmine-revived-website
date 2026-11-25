FROM node:22-alpine

WORKDIR /app

COPY server.js ./
RUN mkdir -p /data/articles

ENV NODE_ENV=production
ENV PORT=3000
ENV ARTICLES_DIR=/data/articles

EXPOSE 3000

CMD ["node", "server.js"]