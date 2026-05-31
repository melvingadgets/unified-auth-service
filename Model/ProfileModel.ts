import mongoose from "mongoose";

export interface AuthProfile {
  user: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  dateOfBirth?: Date;
  gender?: string;
  address?: string;
  avatar?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthProfileDocument extends AuthProfile, mongoose.Document {}

const ProfileSchema = new mongoose.Schema<AuthProfileDocument>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "auth_user",
      required: true,
      unique: true,
      index: true,
    },
    firstName: {
      type: String,
      trim: true,
      default: "",
    },
    lastName: {
      type: String,
      trim: true,
      default: "",
    },
    phoneNumber: {
      type: String,
      trim: true,
      default: "",
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    avatar: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

export default mongoose.model<AuthProfileDocument>("auth_profile", ProfileSchema);
