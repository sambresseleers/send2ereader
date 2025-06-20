# Use a Node.js base image
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Install dependencies for kepubify, kindlegen, and pdfCropMargins
# pdfCropMargins requires python and pip
RUN apk add --no-cache python3 py3-pip wget unzip

# Install Kepubify
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.2.0/kepubify-linux-64bit.zip -O kepubify.zip && \
    unzip kepubify.zip && \
    mv kepubify /usr/local/bin/kepubify && \
    rm kepubify.zip

# Install KindleGen
# Using the Internet Archive link as the official one is dead
RUN wget http://web.archive.org/web/20190328114454/http://kindlegen.s3.amazonaws.com/kindlegen_linux_2.6_i386_v2_9.tar.gz -O kindlegen.tar.gz && \
    tar -xzf kindlegen.tar.gz && \
    mv kindlegen /usr/local/bin/kindlegen && \
    rm kindlegen.tar.gz

# Install pdfCropMargins
RUN pip3 install --no-cache-dir pdfCropMargins

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of your application's source code
COPY . .

# Expose the port the app runs on
EXPOSE 3001

# Command to run the application
CMD [ "npm", "start" ]
